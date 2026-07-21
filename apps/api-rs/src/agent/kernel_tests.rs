use std::collections::VecDeque;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use tokio::sync::{mpsc::unbounded_channel, Mutex};
use uuid::Uuid;

use super::generator::{AnswerGenerator, AnswerStream};
use super::prompt::{BuiltinPromptRegistry, Prompt};
use super::reasoner::{
    AgentReasoner, QueryUnderstanding, ReactActionKind, ReactDecision, ReactStateView, SearchAction,
};
use super::verifier::{ClaimVerifier, VerificationReport};
use super::{AgentKernel, AgentProgress};
use crate::models::agent::{
    AgentMode, AgentOptions, AgentRequest, AnswerStreamItem, CitationOutput, GenerationConfig,
};
use crate::models::rag::{
    EvidencePack, RerankInput, RerankedChunk, RetrievalInput, RetrievalOutput, RetrievedChunk,
};
use crate::models::trace::RetrievalSource;
use crate::models::{Confidence, NoAnswerReason, Usage};
use crate::rag::{ContextAssembler, Reranker, Retriever, SimpleContextAssembler};

struct QueuedReasoner {
    understanding: QueryUnderstanding,
    decisions: Mutex<VecDeque<ReactDecision>>,
}

#[async_trait::async_trait]
impl AgentReasoner for QueuedReasoner {
    async fn understand(
        &self,
        _original_query: &str,
        _history: &[crate::models::agent::ConversationTurn],
        _allow_analyst_mode: bool,
    ) -> Result<QueryUnderstanding> {
        Ok(self.understanding.clone())
    }

    async fn decide(&self, _state: &ReactStateView<'_>) -> Result<ReactDecision> {
        self.decisions
            .lock()
            .await
            .pop_front()
            .ok_or_else(|| anyhow!("test reasoner decision queue is empty"))
    }

    fn component_name(&self) -> String {
        "queued-test-reasoner".to_string()
    }
}

struct RecordingRetriever {
    calls: Mutex<Vec<Vec<String>>>,
}

#[async_trait::async_trait]
impl Retriever for RecordingRetriever {
    async fn retrieve(&self, input: RetrievalInput) -> Result<RetrievalOutput> {
        let call_number = {
            let mut calls = self.calls.lock().await;
            calls.push(input.queries);
            calls.len()
        };
        Ok(RetrievalOutput {
            chunks: vec![test_chunk(call_number)],
            warnings: vec![],
        })
    }

    fn component_name(&self) -> String {
        "recording-test-retriever".to_string()
    }
}

struct PassingReranker;

#[async_trait::async_trait]
impl Reranker for PassingReranker {
    async fn rerank(&self, input: RerankInput) -> Result<Vec<RerankedChunk>> {
        Ok(input
            .chunks
            .into_iter()
            .take(input.top_k)
            .enumerate()
            .map(|(index, chunk)| RerankedChunk {
                chunk,
                score: 0.95,
                rank: index as i32 + 1,
            })
            .collect())
    }

    fn component_name(&self) -> String {
        "passing-test-reranker".to_string()
    }
}

struct EvidenceAnswerGenerator;

#[async_trait::async_trait]
impl AnswerGenerator for EvidenceAnswerGenerator {
    async fn generate(
        &self,
        _query: String,
        evidence: EvidencePack,
        _prompt: Prompt,
        _config: GenerationConfig,
        _verifier: Arc<dyn ClaimVerifier>,
        _require_citation: bool,
        _max_repair_attempts: usize,
    ) -> Result<AnswerStream> {
        let item = evidence
            .chunks
            .first()
            .ok_or_else(|| anyhow!("test generator requires evidence"))?;
        let citation = CitationOutput {
            index: 1,
            chunk_id: item.chunk.chunk_id,
            doc_id: item.chunk.doc_id,
            doc_title: item.chunk.doc_title.clone(),
            page_range: item.chunk.page_range.clone(),
            quote: item.chunk.content.clone(),
            score: item.score,
            source_status: "available".to_string(),
            anchor: None,
        };
        let (sender, receiver) = unbounded_channel();
        sender.send(AnswerStreamItem::Delta {
            text: "已基于检索证据回答 [1]".to_string(),
        })?;
        sender.send(AnswerStreamItem::Citation { citation })?;
        sender.send(AnswerStreamItem::Completed {
            confidence: Confidence::High,
            usage: Some(Usage {
                input_tokens: 20,
                output_tokens: 10,
            }),
        })?;
        Ok(receiver)
    }

    fn component_name(&self) -> String {
        "evidence-test-generator".to_string()
    }
}

struct PassingVerifier;

#[async_trait::async_trait]
impl ClaimVerifier for PassingVerifier {
    async fn verify(
        &self,
        _query: &str,
        _answer: &str,
        _evidence: &EvidencePack,
        _require_citation: bool,
    ) -> Result<VerificationReport> {
        Ok(VerificationReport {
            supported: true,
            confidence: Confidence::High,
            issues: vec![],
            claims: vec![],
            corrected_answer: None,
        })
    }

    fn component_name(&self) -> String {
        "passing-test-verifier".to_string()
    }
}

#[tokio::test]
async fn react_loop_can_search_twice_before_finishing() -> Result<()> {
    let retriever = Arc::new(RecordingRetriever {
        calls: Mutex::new(vec![]),
    });
    let reasoner = Arc::new(QueuedReasoner {
        understanding: understanding(false),
        decisions: Mutex::new(VecDeque::from([
            search_decision("先查付款条件", "合同付款条件"),
            search_decision("补查验收条件", "合同验收条件"),
            ReactDecision {
                action: ReactActionKind::Finish,
                decision_summary: "两部分证据已经覆盖".to_string(),
                search: None,
                answer_focus: Some("准确合并付款与验收条件".to_string()),
                clarification_question: None,
                selected_evidence_ids: vec![1, 2],
            },
        ])),
    });
    let kernel = kernel(reasoner, retriever.clone());
    let prepared = kernel.prepare(request()).await?;
    let (progress_sender, mut progress_receiver) = unbounded_channel();
    let mut run = kernel.run_prepared(prepared, Some(progress_sender)).await?;

    let mut answer = String::new();
    while let Some(item) = run.answer_stream.recv().await {
        if let AnswerStreamItem::Delta { text } = item {
            answer.push_str(&text);
        }
    }
    let calls = retriever.calls.lock().await;
    assert_eq!(calls.len(), 2);
    assert_eq!(run.trace.react_steps.len(), 3);
    assert_eq!(run.trace.react_steps[0].action, "search");
    assert_eq!(run.trace.react_steps[1].action, "search");
    assert_eq!(run.trace.react_steps[2].action, "finish");
    assert!(answer.contains("[1]"));

    let mut tool_starts = 0;
    while let Ok(progress) = progress_receiver.try_recv() {
        if matches!(progress, AgentProgress::ToolCallStarted { .. }) {
            tool_starts += 1;
        }
    }
    assert_eq!(tool_starts, 2);
    Ok(())
}

#[tokio::test]
async fn unresolved_ambiguity_stops_before_any_retrieval() -> Result<()> {
    let retriever = Arc::new(RecordingRetriever {
        calls: Mutex::new(vec![]),
    });
    let reasoner = Arc::new(QueuedReasoner {
        understanding: understanding(true),
        decisions: Mutex::new(VecDeque::from([ReactDecision {
            action: ReactActionKind::Clarify,
            decision_summary: "用户没有提供可区分的合同语义".to_string(),
            search: None,
            answer_focus: None,
            clarification_question: Some("你指的是哪一份合同？".to_string()),
            selected_evidence_ids: vec![],
        }])),
    });
    let mut run = kernel(reasoner, retriever.clone()).run(request()).await?;
    let mut answer = String::new();
    while let Some(item) = run.answer_stream.recv().await {
        if let AnswerStreamItem::Delta { text } = item {
            answer.push_str(&text);
        }
    }
    assert!(retriever.calls.lock().await.is_empty());
    assert_eq!(
        run.no_answer_reason,
        Some(NoAnswerReason::NeedsClarification)
    );
    assert!(answer.contains("哪一份合同"));
    Ok(())
}

#[test]
fn missing_rerank_query_uses_model_generated_search_query() -> Result<()> {
    let mut decision: ReactDecision = serde_json::from_value(serde_json::json!({
        "action": "search",
        "decision_summary": "检索明确命名的合同",
        "search": {"queries": ["DocuMind API 测试采购合同付款节点"]},
        "answer_focus": null,
        "clarification_question": null
    }))?;
    super::reasoner::validate_decision(&mut decision, 4, None)?;
    assert_eq!(
        decision.search.expect("search action").rerank_query,
        "DocuMind API 测试采购合同付款节点"
    );
    Ok(())
}

#[test]
fn missing_finish_focus_uses_llm_understanding_strategy() -> Result<()> {
    let mut decision: ReactDecision = serde_json::from_value(serde_json::json!({
        "action": "finish",
        "decision_summary": "证据已覆盖问题",
        "search": null,
        "clarification_question": null
    }))?;
    super::reasoner::validate_decision(&mut decision, 4, Some("分析付款与验收记录之间的流程依赖"))?;
    assert_eq!(
        decision.answer_focus.as_deref(),
        Some("分析付款与验收记录之间的流程依赖")
    );
    Ok(())
}

fn kernel(reasoner: Arc<dyn AgentReasoner>, retriever: Arc<dyn Retriever>) -> AgentKernel {
    AgentKernel::new(
        reasoner,
        retriever,
        Arc::new(PassingReranker),
        Arc::new(SimpleContextAssembler::new()) as Arc<dyn ContextAssembler>,
        Arc::new(EvidenceAnswerGenerator),
        Arc::new(BuiltinPromptRegistry::new()),
        Arc::new(PassingVerifier),
    )
}

fn understanding(needs_clarification: bool) -> QueryUnderstanding {
    QueryUnderstanding {
        mode: if needs_clarification {
            AgentMode::Clarifier
        } else {
            AgentMode::Answerer
        },
        standalone_query: "采购合同付款与验收条件是什么？".to_string(),
        keywords: vec!["采购合同".to_string()],
        resolved_references: vec![],
        needs_clarification,
        clarification_question: needs_clarification.then(|| "你指的是哪一份合同？".to_string()),
        context_dependent: false,
        time_sensitive: false,
        memory_summary: "关注采购合同付款与验收条件".to_string(),
        response_strategy: "合并相关条件并逐项引用".to_string(),
    }
}

fn search_decision(summary: &str, query: &str) -> ReactDecision {
    ReactDecision {
        action: ReactActionKind::Search,
        decision_summary: summary.to_string(),
        search: Some(SearchAction {
            queries: vec![query.to_string()],
            rerank_query: query.to_string(),
            hypothetical_answer: None,
        }),
        answer_focus: None,
        clarification_question: None,
        selected_evidence_ids: vec![],
    }
}

fn request() -> AgentRequest {
    let mut options = AgentOptions::default();
    options.runtime.max_react_steps = 4;
    AgentRequest {
        tenant_id: Uuid::new_v4(),
        user_id: Uuid::new_v4(),
        conversation_id: Uuid::new_v4(),
        user_message_id: Uuid::new_v4(),
        assistant_message_id: Uuid::new_v4(),
        original_query: "付款和验收分别怎么约定？".to_string(),
        effective_kb_ids: vec![Uuid::new_v4()],
        history: vec![],
        options,
    }
}

fn test_chunk(number: usize) -> RetrievedChunk {
    RetrievedChunk {
        chunk_id: Uuid::new_v4(),
        doc_id: Uuid::new_v4(),
        doc_title: format!("测试合同{number}"),
        file_type: "docx".to_string(),
        content: format!("第{number}轮检索命中的真实证据内容"),
        heading_path: vec!["合同条款".to_string()],
        page_range: vec![number as i32],
        block_ids: vec![],
        table_ids: vec![],
        anchor_ids: vec![],
        primary_anchor_id: None,
        anchor_quality: "structural".to_string(),
        primary_anchor: None,
        metadata: serde_json::json!({}),
        score: 0.8,
        source: RetrievalSource::Rrf,
    }
}
