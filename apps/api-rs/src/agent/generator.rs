use std::sync::Arc;

use anyhow::Result;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

use crate::agent::prompt::Prompt;
use crate::agent::verifier::ClaimVerifier;
use crate::models::agent::{AnswerStreamItem, ConversationTurn, GenerationConfig};
use crate::models::rag::EvidencePack;

pub type AnswerStream = UnboundedReceiver<AnswerStreamItem>;

#[async_trait::async_trait]
pub trait AnswerGenerator: Send + Sync {
    async fn generate(
        &self,
        query: String,
        evidence: EvidencePack,
        prompt: Prompt,
        config: GenerationConfig,
        verifier: Arc<dyn ClaimVerifier>,
    ) -> Result<AnswerStream>;

    async fn chat(
        &self,
        query: String,
        history: Vec<ConversationTurn>,
        config: GenerationConfig,
    ) -> Result<AnswerStream>;
}

pub struct MockAnswerGenerator;

impl MockAnswerGenerator {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MockAnswerGenerator {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AnswerGenerator for MockAnswerGenerator {
    async fn generate(
        &self,
        query: String,
        evidence: EvidencePack,
        _prompt: Prompt,
        _config: GenerationConfig,
        verifier: Arc<dyn ClaimVerifier>,
    ) -> Result<AnswerStream> {
        let (tx, rx) = unbounded_channel();
        let answer = build_answer(&query, &evidence);
        let citations = crate::agent::citation_resolver::resolve_citations(&answer, &evidence);

        let report = verifier.verify(&answer, &evidence).await;
        let confidence = report.confidence;
        let issues = report.issues;
        let usage_input = 512;
        let usage_output = answer.len() as u32;

        tokio::spawn(async move {
            for segment in split_answer(&answer) {
                let _ = tx.send(AnswerStreamItem::Delta { text: segment });
                tokio::task::yield_now().await;
            }
            for citation in citations {
                let _ = tx.send(AnswerStreamItem::Citation { citation });
            }
            if !issues.is_empty() {
                let note = format!("\n[校验提示] {}", issues.join("；"));
                for segment in split_answer(&note) {
                    let _ = tx.send(AnswerStreamItem::Delta { text: segment });
                }
            }
            let _ = tx.send(AnswerStreamItem::Completed {
                confidence,
                usage: Some(crate::models::Usage {
                    input_tokens: usage_input,
                    output_tokens: usage_output + issues.len() as u32 * 10,
                }),
            });
        });

        Ok(rx)
    }

    async fn chat(
        &self,
        query: String,
        _history: Vec<ConversationTurn>,
        _config: GenerationConfig,
    ) -> Result<AnswerStream> {
        let (tx, rx) = unbounded_channel();
        let answer = format!(
            "你好！我是 DocuMind。当前未接入真实大模型，所以这是模拟回复。如果是真实模型，我会针对「{}」给出流式回答。",
            query
        );
        tokio::spawn(async move {
            for segment in split_answer(&answer) {
                let _ = tx.send(AnswerStreamItem::Delta { text: segment });
                tokio::task::yield_now().await;
            }
            let _ = tx.send(AnswerStreamItem::Completed {
                confidence: crate::models::Confidence::Medium,
                usage: Some(crate::models::Usage {
                    input_tokens: 0,
                    output_tokens: answer.len() as u32,
                }),
            });
        });
        Ok(rx)
    }
}

fn build_answer(query: &str, evidence: &EvidencePack) -> String {
    let q = query.to_lowercase();
    if evidence.chunks.is_empty() {
        return "文档中未找到与该问题直接相关的信息。".to_string();
    }

    if q.contains("对比") || q.contains("区别") || q.contains("相比") {
        return build_comparison_answer(&evidence.chunks);
    }
    if q.contains("总结") || q.contains("摘要") || q.contains("讲了什么") {
        return build_summary_answer(&evidence.chunks);
    }
    if q.contains("是否") || q.contains("风险") || q.contains("合理") || q.contains("违规")
    {
        return build_analyst_answer(&evidence.chunks);
    }
    if q.contains("付款") || q.contains("支付") || q.contains("节点") {
        if let Some((index, c)) = find_chunk_with_index(&evidence.chunks, &["付款", "支付", "节点"])
        {
            return format!("根据《{}》第{}页，付款节点为：合同签署后支付首付款30%，验收通过后支付60%，质保期结束支付10%。[{}]", c.chunk.doc_title, page_str(&c.chunk.page_range), index);
        }
    }
    if q.contains("违约") || q.contains("违约金") || q.contains("责任") {
        if let Some((index, c)) =
            find_chunk_with_index(&evidence.chunks, &["违约", "违约金", "责任"])
        {
            return format!("根据《{}》第{}页，违约责任为：任何一方未按约定履行合同义务，应向对方支付合同金额10%的违约金。[{}]", c.chunk.doc_title, page_str(&c.chunk.page_range), index);
        }
    }
    if q.contains("报销") {
        if let Some((index, c)) = find_chunk_with_index(&evidence.chunks, &["报销", "发票", "费用"])
        {
            return format!("根据《{}》第{}页，员工报销需提交发票原件、费用明细、审批单，并在费用发生后30个工作日内提交。[{}]", c.chunk.doc_title, page_str(&c.chunk.page_range), index);
        }
    }
    if q.contains("销售") || q.contains("目标") || q.contains("华东") {
        if let Some(c) = evidence.chunks.first() {
            return format!("根据《{}》第{}页，Q3华东区域销售目标为1200万元，较去年同期增长15%，其中新客户占比不低于30%。[1]", c.chunk.doc_title, page_str(&c.chunk.page_range));
        }
    }

    if let Some(c) = evidence.chunks.first() {
        return format!(
            "根据《{}》第{}页，{}[1]",
            c.chunk.doc_title,
            page_str(&c.chunk.page_range),
            c.chunk.content
        );
    }
    "文档中未找到与该问题直接相关的信息。".to_string()
}

fn build_comparison_answer(chunks: &[crate::models::rag::RerankedChunk]) -> String {
    let payment = find_chunk_with_index(chunks, &["付款", "支付", "节点"]);
    let expense = find_chunk_with_index(chunks, &["报销", "提交", "费用"]);

    match (payment, expense) {
        (Some((payment_index, _)), Some((expense_index, _))) => format!(
            "对比来看：采购合同关注付款节点，约定合同签署后支付首付款30%、验收通过后支付60%、质保期结束支付10%。[{}] 报销制度关注提交时限和材料，要求费用发生后30个工作日内提交，并提交发票原件、费用明细、审批单。[{}]",
            payment_index, expense_index
        ),
        (Some((index, chunk)), None) | (None, Some((index, chunk))) => format!(
            "目前只找到一侧证据：《{}》第{}页提到：{}[{}] 另一侧未找到明确说明。",
            chunk.chunk.doc_title,
            page_str(&chunk.chunk.page_range),
            compact_quote(&chunk.chunk.content),
            index
        ),
        (None, None) => fallback_evidence_answer(chunks),
    }
}

fn build_summary_answer(chunks: &[crate::models::rag::RerankedChunk]) -> String {
    let bullets: Vec<String> = chunks
        .iter()
        .take(3)
        .enumerate()
        .map(|(index, chunk)| {
            format!(
                "{}. 《{}》第{}页：{}[{}]",
                index + 1,
                chunk.chunk.doc_title,
                page_str(&chunk.chunk.page_range),
                compact_quote(&chunk.chunk.content),
                index + 1
            )
        })
        .collect();
    format!(
        "根据已检索到的文档，核心内容可以概括为：\n{}",
        bullets.join("\n")
    )
}

fn build_analyst_answer(chunks: &[crate::models::rag::RerankedChunk]) -> String {
    if let Some((index, chunk)) = find_chunk_with_index(chunks, &["验收", "审批", "风险", "流程"])
    {
        return format!(
            "基于文档证据，可以确认相关流程依据是：{}[{}] 这提示需要关注流程节点是否完整闭环；但是否构成违规或最终风险等级，仍需要结合企业制度和实际执行记录人工确认。",
            compact_quote(&chunk.chunk.content),
            index
        );
    }
    fallback_evidence_answer(chunks)
}

fn fallback_evidence_answer(chunks: &[crate::models::rag::RerankedChunk]) -> String {
    if let Some(chunk) = chunks.first() {
        return format!(
            "根据《{}》第{}页，{}[1]",
            chunk.chunk.doc_title,
            page_str(&chunk.chunk.page_range),
            compact_quote(&chunk.chunk.content)
        );
    }
    "文档中未找到与该问题直接相关的信息。".to_string()
}

fn find_chunk_with_index<'a>(
    chunks: &'a [crate::models::rag::RerankedChunk],
    needles: &[&str],
) -> Option<(usize, &'a crate::models::rag::RerankedChunk)> {
    chunks
        .iter()
        .enumerate()
        .find(|(_, chunk)| {
            needles.iter().any(|needle| {
                chunk.chunk.content.contains(needle) || chunk.chunk.doc_title.contains(needle)
            })
        })
        .map(|(index, chunk)| (index + 1, chunk))
}

fn compact_quote(content: &str) -> String {
    const MAX_CHARS: usize = 120;
    let text = content.replace('\n', " ");
    let mut quote: String = text.chars().take(MAX_CHARS).collect();
    if text.chars().count() > MAX_CHARS {
        quote.push_str("...");
    }
    quote
}

fn page_str(pages: &[i32]) -> String {
    pages
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join("-")
}

fn split_answer(answer: &str) -> Vec<String> {
    // Split by sentence-ending punctuation to simulate streaming.
    let mut segments = vec![];
    let mut current = String::new();
    for ch in answer.chars() {
        current.push(ch);
        if ch == '。' || ch == '；' || ch == '？' || ch == '！' {
            segments.push(current.clone());
            current.clear();
        }
    }
    if !current.is_empty() {
        segments.push(current);
    }
    if segments.is_empty() {
        segments.push(answer.to_string());
    }
    segments
}
