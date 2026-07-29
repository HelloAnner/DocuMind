mod clarification;
mod knowledge_search;
mod registry;

use anyhow::Result;
use serde_json::Value;

use crate::agent::events::ProgressSender;
use crate::agent::model::{AgentToolCall, AgentToolDefinition};
use crate::models::agent::{AgentMode, AgentRequest};
use crate::models::rag::RerankedChunk;
use crate::models::trace::{ResolvedRef, RetrievalTrace, SubQuery};
use crate::models::{Confidence, NoAnswerReason};
use uuid::Uuid;

pub use clarification::ClarificationTool;
pub use knowledge_search::KnowledgeSearchTool;
pub use registry::AgentToolRegistry;

pub struct ToolExecutionContext<'a> {
    pub request: &'a AgentRequest,
    pub progress: &'a ProgressSender,
}

#[derive(Debug)]
pub struct KnowledgeSearchEffect {
    pub chunks: Vec<RerankedChunk>,
    pub retrieval_traces: Vec<RetrievalTrace>,
    pub retrieved_chunk_ids: Vec<Uuid>,
    pub queries: Vec<SubQuery>,
    pub rerank_query: String,
    pub hypothetical_answer: Option<String>,
    pub keywords: Vec<String>,
    pub resolved_refs: Vec<ResolvedRef>,
    pub warnings: Vec<String>,
    pub mode: Option<AgentMode>,
}

#[derive(Debug)]
pub struct TerminalToolEffect {
    pub answer: String,
    pub mode: AgentMode,
    pub confidence: Confidence,
    pub no_answer_reason: Option<NoAnswerReason>,
}

#[derive(Debug)]
pub enum ToolEffect {
    None,
    KnowledgeSearch(KnowledgeSearchEffect),
    Terminal(TerminalToolEffect),
}

#[derive(Debug)]
pub struct ToolExecution {
    pub public_result: Value,
    pub model_result: Value,
    pub effect: ToolEffect,
}

#[async_trait::async_trait]
pub trait AgentTool: Send + Sync {
    fn definition(&self) -> AgentToolDefinition;

    async fn execute(
        &self,
        call: &AgentToolCall,
        context: &ToolExecutionContext<'_>,
    ) -> Result<ToolExecution>;

    fn component_name(&self) -> String;
}
