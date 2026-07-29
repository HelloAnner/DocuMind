use std::collections::VecDeque;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::finalizer::GroundedAnswerFinalizer;
use super::model::{AgentModel, AgentModelRequest, AgentModelResponse, AgentToolCall};
use super::prompt::BuiltinPromptRegistry;
use super::tools::{AgentToolRegistry, ClarificationTool, KnowledgeSearchTool};
use super::verifier::{ClaimVerifier, VerificationReport};
use super::AgentKernel;
use crate::models::agent::{AgentMode, AgentOptions, AgentRequest, AnswerStreamItem};
use crate::models::rag::{
    EvidencePack, RerankInput, RerankedChunk, RetrievalInput, RetrievalOutput, RetrievedChunk,
};
use crate::models::trace::RetrievalSource;
use crate::models::{Confidence, NoAnswerReason, Usage};
use crate::rag::{ContextAssembler, Reranker, Retriever, SimpleContextAssembler};

struct QueuedModel {
    responses: Mutex<VecDeque<AgentModelResponse>>,
    requests: Mutex<Vec<AgentModelRequest>>,
}

#[async_trait::async_trait]
impl AgentModel for QueuedModel {
    async fn complete(&self, request: AgentModelRequest) -> Result<AgentModelResponse> {
        self.requests.lock().await.push(request);
        self.responses
            .lock()
            .await
            .pop_front()
            .ok_or_else(|| anyhow!("test model response queue is empty"))
    }

    fn component_name(&self) -> String {
        "queued-agent-model".to_string()
    }
}

struct RecordingRetriever {
    calls: Mutex<Vec<Vec<String>>>,
    return_chunks: bool,
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
            chunks: self
                .return_chunks
                .then(|| vec![test_chunk(call_number)])
                .unwrap_or_default(),
            warnings: Vec::new(),
        })
    }

    fn component_name(&self) -> String {
        "recording-retriever".to_string()
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
        "passing-reranker".to_string()
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
            issues: Vec::new(),
            claims: Vec::new(),
            corrected_answer: None,
        })
    }

    fn component_name(&self) -> String {
        "passing-verifier".to_string()
    }
}

#[tokio::test]
async fn direct_greeting_finishes_without_tools() -> Result<()> {
    let model = queued_model(vec![text_response("你好！有什么我可以帮你的吗？")]);
    let retriever = recording_retriever(true);
    let mut run = kernel(model.clone(), retriever.clone())
        .run(request("你好"))
        .await?;
    let (answer, citations, confidence) = collect_answer(&mut run).await;

    assert!(answer.contains("你好"));
    assert!(citations.is_empty());
    assert_eq!(confidence, Some(Confidence::Medium));
    assert!(retriever.calls.lock().await.is_empty());
    assert_eq!(model.requests.lock().await.len(), 1);
    assert_eq!(run.trace.stop_reason, "direct_response");
    assert_eq!(run.trace.react_steps[0].action, "respond");
    Ok(())
}

#[tokio::test]
async fn model_can_search_twice_then_answer_with_citations() -> Result<()> {
    let model = queued_model(vec![
        tool_response(search_call("call-1", "合同付款条件")),
        tool_response(search_call("call-2", "合同验收条件")),
        text_response("付款和验收条件分别见对应条款。[1][2]"),
    ]);
    let retriever = recording_retriever(true);
    let mut run = kernel(model, retriever.clone())
        .run(request("付款和验收分别怎么约定？"))
        .await?;
    let (answer, citations, confidence) = collect_answer(&mut run).await;

    assert!(answer.contains("[1][2]"));
    assert_eq!(citations.len(), 2);
    assert_eq!(confidence, Some(Confidence::High));
    assert_eq!(retriever.calls.lock().await.len(), 2);
    assert_eq!(run.trace.stop_reason, "grounded_response");
    assert_eq!(
        run.trace
            .react_steps
            .iter()
            .map(|step| step.action.as_str())
            .collect::<Vec<_>>(),
        vec!["knowledge_search", "knowledge_search", "respond"]
    );
    assert_eq!(
        run.trace.react_steps[0].queries,
        vec!["合同付款条件".to_string()]
    );
    assert_eq!(run.trace.react_steps[0].retrieved_chunk_ids.len(), 1);
    assert_eq!(run.trace.react_steps[0].accepted_chunk_ids.len(), 1);
    assert_eq!(run.trace.keywords, vec!["合同".to_string()]);
    Ok(())
}

#[tokio::test]
async fn search_without_evidence_is_not_misclassified_as_direct_answer() -> Result<()> {
    let model = queued_model(vec![
        tool_response(search_call("search-empty", "不存在的制度")),
        text_response("当前知识库中没有找到相关内容。"),
    ]);
    let retriever = recording_retriever(false);
    let mut run = kernel(model, retriever)
        .run(request("不存在的制度怎么规定？"))
        .await?;
    let (answer, citations, confidence) = collect_answer(&mut run).await;

    assert!(answer.contains("没有找到"));
    assert!(citations.is_empty());
    assert_eq!(confidence, Some(Confidence::Low));
    assert_eq!(run.no_answer_reason, Some(NoAnswerReason::NoRelevantChunks));
    assert_eq!(run.trace.stop_reason, "no_relevant_evidence_response");
    Ok(())
}

#[tokio::test]
async fn clarification_tool_stops_without_retrieval() -> Result<()> {
    let call = AgentToolCall {
        id: "clarify-1".to_string(),
        name: "ask_clarification".to_string(),
        arguments_json: serde_json::json!({
            "question": "你指的是哪一份合同？",
            "reason": "存在两个不同对象"
        })
        .to_string(),
    };
    let model = queued_model(vec![tool_response(call)]);
    let retriever = recording_retriever(true);
    let mut run = kernel(model, retriever.clone())
        .run(request("它的付款条件是什么？"))
        .await?;
    let (answer, citations, confidence) = collect_answer(&mut run).await;

    assert_eq!(answer, "你指的是哪一份合同？");
    assert!(citations.is_empty());
    assert_eq!(confidence, Some(Confidence::Low));
    assert_eq!(run.mode, AgentMode::Clarifier);
    assert_eq!(
        run.no_answer_reason,
        Some(NoAnswerReason::NeedsClarification)
    );
    assert!(retriever.calls.lock().await.is_empty());
    Ok(())
}

#[tokio::test]
async fn duplicate_tool_call_executes_only_once() -> Result<()> {
    let repeated = search_call("search-1", "采购合同付款条件");
    let model = queued_model(vec![
        tool_response(repeated.clone()),
        tool_response(AgentToolCall {
            id: "search-2".to_string(),
            ..repeated
        }),
        text_response("已根据现有证据回答。[1]"),
    ]);
    let retriever = recording_retriever(true);
    let mut run = kernel(model, retriever.clone())
        .run(request("采购合同付款条件是什么？"))
        .await?;
    let _ = collect_answer(&mut run).await;

    assert_eq!(retriever.calls.lock().await.len(), 1);
    assert!(run
        .trace
        .react_steps
        .iter()
        .any(|step| step.warnings.iter().any(|item| item.contains("identical"))));
    Ok(())
}

#[tokio::test]
async fn current_greeting_remains_last_user_message_after_document_history() -> Result<()> {
    let model = queued_model(vec![text_response("你好！")]);
    let retriever = recording_retriever(true);
    let mut req = request("你好");
    req.history.push(crate::models::agent::ConversationTurn {
        user_message: "合同验证码是什么？".to_string(),
        assistant_answer: "验证码是 73941。[1]".to_string(),
        citations: vec!["测试合同".to_string()],
    });
    let mut run = kernel(model.clone(), retriever).run(req).await?;
    let _ = collect_answer(&mut run).await;

    let requests = model.requests.lock().await;
    let last = requests[0]
        .messages
        .last()
        .and_then(|message| message.content.as_deref());
    assert_eq!(last, Some("你好"));
    Ok(())
}

#[tokio::test]
async fn history_citation_cannot_bypass_current_turn_retrieval() -> Result<()> {
    let model = queued_model(vec![
        text_response("历史里说城市是 HANGZHOU [1]。"),
        tool_response(search_call("search-current", "PVSMOKE-747FE38D 城市")),
        text_response("当前证据显示城市是 HANGZHOU [1]。"),
    ]);
    let retriever = recording_retriever(true);
    let mut req = request("刚才那个 OCR 文档的城市呢？");
    req.history.push(crate::models::agent::ConversationTurn {
        user_message: "OCR 文档 PVSMOKE-747FE38D 的验证码是什么？".to_string(),
        assistant_answer: "验证码是 73941。[1]".to_string(),
        citations: vec!["ocr-smoke-PVSMOKE-747FE38D".to_string()],
    });
    let mut run = kernel(model.clone(), retriever.clone()).run(req).await?;
    let (answer, citations, confidence) = collect_answer(&mut run).await;

    assert_eq!(retriever.calls.lock().await.len(), 1);
    assert!(answer.contains("当前证据"));
    assert_eq!(citations.len(), 1);
    assert_eq!(confidence, Some(Confidence::High));
    assert_eq!(model.requests.lock().await.len(), 3);
    assert!(run.trace.react_steps[0]
        .warnings
        .iter()
        .any(|warning| warning.contains("no document evidence")));
    Ok(())
}

fn kernel(model: Arc<QueuedModel>, retriever: Arc<RecordingRetriever>) -> AgentKernel {
    let reranker: Arc<dyn Reranker> = Arc::new(PassingReranker);
    let tools = AgentToolRegistry::new(vec![
        Arc::new(KnowledgeSearchTool::new(retriever, reranker)),
        Arc::new(ClarificationTool),
    ])
    .expect("test tool registry should be valid");
    AgentKernel::new(
        model,
        tools,
        Arc::new(SimpleContextAssembler::new()) as Arc<dyn ContextAssembler>,
        Arc::new(BuiltinPromptRegistry::new()),
        Arc::new(GroundedAnswerFinalizer::new(Arc::new(PassingVerifier))),
    )
    .expect("test kernel should be valid")
}

fn queued_model(responses: Vec<AgentModelResponse>) -> Arc<QueuedModel> {
    Arc::new(QueuedModel {
        responses: Mutex::new(VecDeque::from(responses)),
        requests: Mutex::new(Vec::new()),
    })
}

fn recording_retriever(return_chunks: bool) -> Arc<RecordingRetriever> {
    Arc::new(RecordingRetriever {
        calls: Mutex::new(Vec::new()),
        return_chunks,
    })
}

fn text_response(content: &str) -> AgentModelResponse {
    AgentModelResponse {
        content: Some(content.to_string()),
        tool_calls: Vec::new(),
        usage: Some(Usage {
            input_tokens: 10,
            output_tokens: 5,
        }),
        finish_reason: Some("stop".to_string()),
    }
}

fn tool_response(call: AgentToolCall) -> AgentModelResponse {
    AgentModelResponse {
        content: None,
        tool_calls: vec![call],
        usage: Some(Usage {
            input_tokens: 10,
            output_tokens: 5,
        }),
        finish_reason: Some("tool_calls".to_string()),
    }
}

fn search_call(id: &str, query: &str) -> AgentToolCall {
    AgentToolCall {
        id: id.to_string(),
        name: "knowledge_search".to_string(),
        arguments_json: serde_json::json!({
            "queries": [query],
            "rerank_query": query,
            "hypothetical_answer": null,
            "response_mode": "answerer",
            "keywords": ["合同"],
            "resolved_references": [],
            "reason": "查找用户请求的文档事实"
        })
        .to_string(),
    }
}

fn request(query: &str) -> AgentRequest {
    let mut options = AgentOptions::default();
    options.runtime.max_react_steps = 4;
    AgentRequest {
        tenant_id: Uuid::new_v4(),
        user_id: Uuid::new_v4(),
        conversation_id: Uuid::new_v4(),
        user_message_id: Uuid::new_v4(),
        assistant_message_id: Uuid::new_v4(),
        original_query: query.to_string(),
        effective_kb_ids: vec![Uuid::new_v4()],
        history: Vec::new(),
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
        block_ids: Vec::new(),
        table_ids: Vec::new(),
        anchor_ids: Vec::new(),
        primary_anchor_id: None,
        anchor_quality: "structural".to_string(),
        primary_anchor: None,
        metadata: serde_json::json!({}),
        score: 0.8,
        source: RetrievalSource::Rrf,
    }
}

async fn collect_answer(
    run: &mut crate::models::agent::AgentRun,
) -> (
    String,
    Vec<crate::models::agent::CitationOutput>,
    Option<Confidence>,
) {
    let mut answer = String::new();
    let mut citations = Vec::new();
    let mut confidence = None;
    while let Some(item) = run.answer_stream.recv().await {
        match item {
            AnswerStreamItem::Delta { text } => answer.push_str(&text),
            AnswerStreamItem::Replace { text } => answer = text,
            AnswerStreamItem::Citation { citation } => citations.push(citation),
            AnswerStreamItem::Completed { confidence: c, .. } => confidence = Some(c),
            AnswerStreamItem::Failed { .. } => {}
        }
    }
    (answer, citations, confidence)
}
