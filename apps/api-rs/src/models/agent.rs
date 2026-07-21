use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedReceiver;
use uuid::Uuid;

use super::{Confidence, Usage};
use crate::models::citation::CitationAnchor;
use crate::models::trace::{ResolvedRef, RetrievalPlan, RetrievalTrace};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentMode {
    Answerer,
    Clarifier,
    Summarizer,
    Comparer,
    Analyst,
    Navigator,
    Reviewer,
}

impl std::fmt::Display for AgentMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentMode::Answerer => write!(f, "answerer"),
            AgentMode::Clarifier => write!(f, "clarifier"),
            AgentMode::Summarizer => write!(f, "summarizer"),
            AgentMode::Comparer => write!(f, "comparer"),
            AgentMode::Analyst => write!(f, "analyst"),
            AgentMode::Navigator => write!(f, "navigator"),
            AgentMode::Reviewer => write!(f, "reviewer"),
        }
    }
}

impl std::str::FromStr for AgentMode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "answerer" => Ok(AgentMode::Answerer),
            "clarifier" => Ok(AgentMode::Clarifier),
            "summarizer" => Ok(AgentMode::Summarizer),
            "comparer" => Ok(AgentMode::Comparer),
            "analyst" => Ok(AgentMode::Analyst),
            "navigator" => Ok(AgentMode::Navigator),
            "reviewer" => Ok(AgentMode::Reviewer),
            _ => Err(format!("unknown agent mode: {s}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationTurn {
    pub user_message: String,
    pub assistant_answer: String,
    #[serde(default)]
    pub citations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRequest {
    pub tenant_id: Uuid,
    pub user_id: Uuid,
    pub conversation_id: Uuid,
    pub user_message_id: Uuid,
    pub assistant_message_id: Uuid,
    pub original_query: String,
    pub effective_kb_ids: Vec<Uuid>,
    pub history: Vec<ConversationTurn>,
    pub options: AgentOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOptions {
    #[serde(default)]
    pub mode: Option<AgentMode>,
    #[serde(default = "default_tone")]
    pub tone: String,
    #[serde(default = "default_true")]
    pub proactive_followup: bool,
    #[serde(default = "default_max_followup")]
    pub max_followup_suggestions: usize,
    #[serde(default = "default_true")]
    pub allow_analyst_mode: bool,
    #[serde(default = "default_true")]
    pub require_citation: bool,
    #[serde(default)]
    pub generation: GenerationConfig,
    #[serde(default)]
    pub retrieval: RetrievalRuntimeConfig,
    #[serde(default)]
    pub runtime: AgentRuntimeConfig,
}

fn default_tone() -> String {
    "concise_warm".to_string()
}
fn default_true() -> bool {
    true
}
fn default_max_followup() -> usize {
    2
}

impl Default for AgentOptions {
    fn default() -> Self {
        Self {
            mode: None,
            tone: default_tone(),
            proactive_followup: true,
            max_followup_suggestions: default_max_followup(),
            allow_analyst_mode: true,
            require_citation: true,
            generation: GenerationConfig::default(),
            retrieval: RetrievalRuntimeConfig::default(),
            runtime: AgentRuntimeConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRuntimeConfig {
    #[serde(default = "default_true")]
    pub hyde_enabled: bool,
    #[serde(default = "default_max_react_steps")]
    pub max_react_steps: usize,
    #[serde(default = "default_max_queries_per_step")]
    pub max_queries_per_step: usize,
    #[serde(default = "default_max_history_turns")]
    pub max_history_turns: usize,
    #[serde(default = "default_max_history_chars")]
    pub max_history_chars: usize,
    #[serde(default = "default_max_context_chars")]
    pub max_context_chars: usize,
    #[serde(default = "default_max_repair_attempts")]
    pub max_repair_attempts: usize,
}

fn default_max_react_steps() -> usize {
    4
}
fn default_max_queries_per_step() -> usize {
    4
}
fn default_max_history_turns() -> usize {
    12
}
fn default_max_history_chars() -> usize {
    24_000
}
fn default_max_context_chars() -> usize {
    30_000
}
fn default_max_repair_attempts() -> usize {
    3
}

impl Default for AgentRuntimeConfig {
    fn default() -> Self {
        Self {
            hyde_enabled: true,
            max_react_steps: default_max_react_steps(),
            max_queries_per_step: default_max_queries_per_step(),
            max_history_turns: default_max_history_turns(),
            max_history_chars: default_max_history_chars(),
            max_context_chars: default_max_context_chars(),
            max_repair_attempts: default_max_repair_attempts(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationConfig {
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    #[serde(default = "default_max_output_tokens")]
    pub max_output_tokens: u32,
}

fn default_model() -> String {
    "qwen-turbo".to_string()
}
fn default_temperature() -> f64 {
    0.2
}
fn default_max_output_tokens() -> u32 {
    1200
}

impl Default for GenerationConfig {
    fn default() -> Self {
        Self {
            model: default_model(),
            temperature: default_temperature(),
            max_output_tokens: default_max_output_tokens(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievalRuntimeConfig {
    #[serde(default = "default_dense_top_k")]
    pub dense_top_k: usize,
    #[serde(default = "default_bm25_top_k")]
    pub bm25_top_k: usize,
    #[serde(default = "default_rrf_top_k")]
    pub rrf_top_k: usize,
    #[serde(default = "default_rerank_top_k")]
    pub rerank_top_k: usize,
    #[serde(default = "default_true")]
    pub rerank_enabled: bool,
}

fn default_dense_top_k() -> usize {
    100
}
fn default_bm25_top_k() -> usize {
    100
}
fn default_rrf_top_k() -> usize {
    20
}
fn default_rerank_top_k() -> usize {
    5
}
impl Default for RetrievalRuntimeConfig {
    fn default() -> Self {
        Self {
            dense_top_k: default_dense_top_k(),
            bm25_top_k: default_bm25_top_k(),
            rrf_top_k: default_rrf_top_k(),
            rerank_top_k: default_rerank_top_k(),
            rerank_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CitationOutput {
    pub index: i32,
    pub chunk_id: Uuid,
    pub doc_id: Uuid,
    pub doc_title: String,
    pub page_range: Vec<i32>,
    pub quote: String,
    pub score: f64,
    #[serde(default = "default_citation_source_status")]
    pub source_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<CitationAnchor>,
}

fn default_citation_source_status() -> String {
    "available".to_string()
}

#[derive(Debug, Clone)]
pub enum AnswerStreamItem {
    Delta {
        text: String,
    },
    Citation {
        citation: CitationOutput,
    },
    Completed {
        confidence: Confidence,
        usage: Option<Usage>,
    },
    Failed {
        code: String,
        message: String,
    },
}

#[derive(Debug)]
pub struct AgentRun {
    pub assistant_message_id: Uuid,
    pub mode: AgentMode,
    pub rewritten_query: Option<String>,
    pub retrieval_plan: RetrievalPlan,
    pub retrieval_traces: Vec<RetrievalTrace>,
    pub answer_stream: UnboundedReceiver<AnswerStreamItem>,
    pub trace: AgentTrace,
    pub no_answer_reason: Option<super::NoAnswerReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTrace {
    pub mode: AgentMode,
    pub mode_reason: String,
    pub rewritten_query: Option<String>,
    pub keywords: Vec<String>,
    pub resolved_refs: Vec<ResolvedRef>,
    pub retrieval_plan: RetrievalPlan,
    pub prompt_versions: PromptVersions,
    pub model: String,
    pub usage: Option<Usage>,
    pub started_at: DateTime<Utc>,
    #[serde(default)]
    pub memory_summary: String,
    #[serde(default)]
    pub react_steps: Vec<ReactStepTrace>,
    #[serde(default)]
    pub stop_reason: String,
    #[serde(default)]
    pub runtime_components: RuntimeComponents,
    #[serde(default)]
    pub cache_key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RuntimeComponents {
    #[serde(default)]
    pub reasoner: String,
    #[serde(default)]
    pub retriever: String,
    #[serde(default)]
    pub reranker: String,
    #[serde(default)]
    pub verifier: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactStepTrace {
    pub step: usize,
    pub action: String,
    pub decision_summary: String,
    #[serde(default)]
    pub queries: Vec<String>,
    #[serde(default)]
    pub rerank_query: Option<String>,
    #[serde(default)]
    pub hypothetical_answer: Option<String>,
    #[serde(default)]
    pub retrieved_chunk_ids: Vec<Uuid>,
    #[serde(default)]
    pub accepted_chunk_ids: Vec<Uuid>,
    #[serde(default)]
    pub warnings: Vec<String>,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptVersions {
    pub persona: String,
    pub guardrail: String,
    pub mode: String,
    pub task: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewriteOutput {
    pub rewritten_query: String,
    pub keywords: Vec<String>,
    pub hypothetical_answer: Option<String>,
    pub resolved_refs: Vec<ResolvedRef>,
    pub added_constraints: Vec<String>,
    pub removed_constraints: Vec<String>,
    pub needs_clarification: bool,
    pub clarification_question: Option<String>,
}
