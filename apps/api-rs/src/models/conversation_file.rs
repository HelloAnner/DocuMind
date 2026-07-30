use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::citation::CitationAnchor;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationFile {
    pub doc_id: Uuid,
    pub doc_title: String,
    pub file_name: String,
    pub file_type: String,
    pub kb_id: Option<Uuid>,
    pub kb_name: Option<String>,
    pub source_status: String,
    pub retrieval_count: i64,
    pub citation_count: i64,
    pub last_used_at: DateTime<Utc>,
    #[serde(default)]
    pub preview_page_range: Vec<i32>,
    #[serde(default)]
    pub preview_quote: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_anchor: Option<CitationAnchor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationFileListResponse {
    pub conversation_id: Uuid,
    pub files: Vec<ConversationFile>,
}
