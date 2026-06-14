use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryTrace {
    pub id: Uuid,
    pub message_id: Uuid,
    pub original_query: String,
    pub rewritten_query: Option<String>,
    pub keywords: Vec<String>,
    pub hypothetical_answer: Option<String>,
    pub resolved_refs: Vec<ResolvedRef>,
    pub effective_kb_ids: Vec<Uuid>,
    pub rewrite_model: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedRef {
    pub text: String,
    pub resolved_to: String,
    #[serde(default)]
    pub source_message_id: Option<Uuid>,
    #[serde(default)]
    pub evidence_message_id: Option<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalSource {
    Dense,
    Bm25,
    Rrf,
    Rerank,
}

impl std::fmt::Display for RetrievalSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RetrievalSource::Dense => write!(f, "dense"),
            RetrievalSource::Bm25 => write!(f, "bm25"),
            RetrievalSource::Rrf => write!(f, "rrf"),
            RetrievalSource::Rerank => write!(f, "rerank"),
        }
    }
}

impl std::str::FromStr for RetrievalSource {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "dense" => Ok(RetrievalSource::Dense),
            "bm25" => Ok(RetrievalSource::Bm25),
            "rrf" => Ok(RetrievalSource::Rrf),
            "rerank" => Ok(RetrievalSource::Rerank),
            _ => Err(format!("unknown retrieval source: {s}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievalTrace {
    pub id: Uuid,
    pub message_id: Uuid,
    pub chunk_id: Uuid,
    pub doc_id: Uuid,
    pub source: RetrievalSource,
    pub rank: i32,
    pub score: f64,
    pub heading_path: Vec<String>,
    pub page_range: Vec<i32>,
    pub content_preview: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanMode {
    Single,
    Multi,
}

impl std::fmt::Display for PlanMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanMode::Single => write!(f, "single_query"),
            PlanMode::Multi => write!(f, "multi_query"),
        }
    }
}

impl std::str::FromStr for PlanMode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "single_query" => Ok(PlanMode::Single),
            "multi_query" => Ok(PlanMode::Multi),
            _ => Err(format!("unknown plan mode: {s}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubQuery {
    pub query: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievalPlan {
    pub mode: PlanMode,
    pub queries: Vec<SubQuery>,
}

impl Default for RetrievalPlan {
    fn default() -> Self {
        Self {
            mode: PlanMode::Single,
            queries: vec![],
        }
    }
}
