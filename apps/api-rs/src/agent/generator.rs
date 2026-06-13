use anyhow::Result;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

use crate::agent::prompt::Prompt;
use crate::models::agent::{AnswerStreamItem, CitationOutput, GenerationConfig};
use crate::models::rag::EvidencePack;

pub type AnswerStream = UnboundedReceiver<AnswerStreamItem>;

#[async_trait::async_trait]
pub trait AnswerGenerator: Send + Sync {
    async fn generate(
        &self,
        query: String,
        evidence: EvidencePack,
        _prompt: Prompt,
        _config: GenerationConfig,
    ) -> Result<AnswerStream>;
}

pub struct MockAnswerGenerator;

impl MockAnswerGenerator {
    pub fn new() -> Self {
        Self
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
    ) -> Result<AnswerStream> {
        let (tx, rx) = unbounded_channel();
        let answer = build_answer(&query, &evidence);
        let citations: Vec<CitationOutput> = evidence
            .chunks
            .iter()
            .enumerate()
            .map(|(i, c)| CitationOutput {
                index: i as i32 + 1,
                chunk_id: c.chunk.chunk_id,
                doc_id: c.chunk.doc_id,
                doc_title: c.chunk.doc_title.clone(),
                page_range: c.chunk.page_range.clone(),
                quote: c.chunk.content.clone(),
                score: c.score,
            })
            .collect();

        tokio::spawn(async move {
            for segment in split_answer(&answer) {
                let _ = tx.send(AnswerStreamItem::Delta { text: segment });
                tokio::task::yield_now().await;
            }
            for citation in citations {
                let _ = tx.send(AnswerStreamItem::Citation { citation });
            }
            let _ = tx.send(AnswerStreamItem::Completed {
                confidence: crate::models::Confidence::High,
                usage: Some(crate::models::Usage {
                    input_tokens: 512,
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

    if q.contains("付款") || q.contains("支付") || q.contains("节点") {
        if let Some(c) = evidence.chunks.first() {
            return format!("根据《{}》第{}页，付款节点为：合同签署后支付首付款30%，验收通过后支付60%，质保期结束支付10%。[1]", c.chunk.doc_title, page_str(&c.chunk.page_range));
        }
    }
    if q.contains("违约") || q.contains("违约金") || q.contains("责任") {
        if let Some(c) = evidence.chunks.first() {
            return format!("根据《{}》第{}页，任何一方未按约定履行合同义务的，应向对方支付合同金额10%的违约金。[1]", c.chunk.doc_title, page_str(&c.chunk.page_range));
        }
    }
    if q.contains("报销") {
        if let Some(c) = evidence.chunks.first() {
            return format!("根据《{}》第{}页，员工报销需提交发票原件、费用明细、审批单，并在费用发生后30个工作日内提交。[1]", c.chunk.doc_title, page_str(&c.chunk.page_range));
        }
    }
    if q.contains("销售") || q.contains("目标") || q.contains("华东") {
        if let Some(c) = evidence.chunks.first() {
            return format!("根据《{}》第{}页，Q3华东区域销售目标为1200万元，较去年同期增长15%，其中新客户占比不低于30%。[1]", c.chunk.doc_title, page_str(&c.chunk.page_range));
        }
    }

    if let Some(c) = evidence.chunks.first() {
        return format!("根据《{}》第{}页，{}[1]", c.chunk.doc_title, page_str(&c.chunk.page_range), c.chunk.content);
    }
    "文档中未找到与该问题直接相关的信息。".to_string()
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
