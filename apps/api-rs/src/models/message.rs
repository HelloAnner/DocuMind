use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{Confidence, MessageRole, MessageStatus, NoAnswerReason};
use crate::models::agent::{AgentMode, PromptVersions};
use crate::models::citation::Citation;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationMessage {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub tenant_id: Uuid,
    pub user_id: Uuid,
    pub role: MessageRole,
    pub content: String,
    pub status: MessageStatus,
    pub parent_message_id: Option<Uuid>,
    pub retry_of_message_id: Option<Uuid>,
    pub client_request_id: Option<String>,
    pub confidence: Option<Confidence>,
    pub no_answer_reason: Option<NoAnswerReason>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub agent_mode: Option<AgentMode>,
    pub prompt_versions: Option<PromptVersions>,
    pub created_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageResponse {
    pub message_id: Uuid,
    pub role: String,
    pub content: String,
    pub status: String,
    pub confidence: Option<String>,
    pub no_answer_reason: Option<String>,
    pub agent_mode: Option<String>,
    pub prompt_versions: Option<PromptVersions>,
    pub citations: Vec<CitationResponse>,
    pub parent_message_id: Option<Uuid>,
    pub retry_of_message_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CitationResponse {
    pub index: i32,
    pub doc_id: Uuid,
    pub chunk_id: Uuid,
    pub doc_title: String,
    pub page_range: Vec<i32>,
    pub quote: String,
}

impl From<&Citation> for CitationResponse {
    fn from(c: &Citation) -> Self {
        Self {
            index: c.index,
            doc_id: c.doc_id,
            chunk_id: c.chunk_id,
            doc_title: c.doc_title.clone(),
            page_range: c.page_range.clone(),
            quote: c.quote.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageRequest {
    pub content: String,
    #[serde(default)]
    pub kb_ids: Vec<Uuid>,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub stream: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageListResponse {
    pub conversation_id: Uuid,
    pub messages: Vec<MessageResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryMessageRequest {
    #[serde(default)]
    pub stream: bool,
}
