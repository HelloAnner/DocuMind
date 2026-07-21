use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::trace::RetrievalSource;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievedChunk {
    pub chunk_id: Uuid,
    pub doc_id: Uuid,
    pub doc_title: String,
    pub file_type: String,
    pub content: String,
    pub heading_path: Vec<String>,
    pub page_range: Vec<i32>,
    pub block_ids: Vec<Uuid>,
    pub table_ids: Vec<Uuid>,
    pub anchor_ids: Vec<Uuid>,
    pub primary_anchor_id: Option<Uuid>,
    pub anchor_quality: String,
    pub primary_anchor: Option<crate::models::SourceAnchor>,
    pub metadata: serde_json::Value,
    pub score: f64,
    pub source: RetrievalSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RerankedChunk {
    pub chunk: RetrievedChunk,
    pub score: f64,
    pub rank: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidencePack {
    pub chunks: Vec<RerankedChunk>,
    pub context_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievalInput {
    pub tenant_id: Uuid,
    pub effective_kb_ids: Vec<Uuid>,
    pub queries: Vec<String>,
    #[serde(default)]
    pub hypothetical_answer: Option<String>,
    pub top_k: usize,
    pub dense_top_k: usize,
    pub bm25_top_k: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievalOutput {
    pub chunks: Vec<RetrievedChunk>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RerankInput {
    pub query: String,
    pub chunks: Vec<RetrievedChunk>,
    pub top_k: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextInput {
    pub chunks: Vec<RerankedChunk>,
    pub original_query: String,
    pub max_context_chars: usize,
}
