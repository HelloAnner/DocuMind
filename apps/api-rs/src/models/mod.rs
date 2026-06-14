pub mod agent;
pub mod citation;
pub mod conversation;
pub mod feedback;
pub mod message;
pub mod rag;
pub mod trace;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ActorScope {
    pub tenant_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub allowed_kb_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

impl std::fmt::Display for Confidence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Confidence::High => write!(f, "high"),
            Confidence::Medium => write!(f, "medium"),
            Confidence::Low => write!(f, "low"),
        }
    }
}

impl std::str::FromStr for Confidence {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "high" => Ok(Confidence::High),
            "medium" => Ok(Confidence::Medium),
            "low" => Ok(Confidence::Low),
            _ => Err(format!("unknown confidence: {s}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoAnswerReason {
    NoRelevantChunks,
    NeedsClarification,
    ScopeDenied,
    PipelineTimeout,
    LlmTimeout,
}

impl std::fmt::Display for NoAnswerReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            NoAnswerReason::NoRelevantChunks => "NO_RELEVANT_CHUNKS",
            NoAnswerReason::NeedsClarification => "NEEDS_CLARIFICATION",
            NoAnswerReason::ScopeDenied => "SCOPE_DENIED",
            NoAnswerReason::PipelineTimeout => "PIPELINE_TIMEOUT",
            NoAnswerReason::LlmTimeout => "LLM_TIMEOUT",
        };
        write!(f, "{s}")
    }
}

impl std::str::FromStr for NoAnswerReason {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "NO_RELEVANT_CHUNKS" => Ok(NoAnswerReason::NoRelevantChunks),
            "NEEDS_CLARIFICATION" => Ok(NoAnswerReason::NeedsClarification),
            "SCOPE_DENIED" => Ok(NoAnswerReason::ScopeDenied),
            "PIPELINE_TIMEOUT" => Ok(NoAnswerReason::PipelineTimeout),
            "LLM_TIMEOUT" => Ok(NoAnswerReason::LlmTimeout),
            _ => Err(format!("unknown no answer reason: {s}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
}

impl std::fmt::Display for MessageRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MessageRole::User => write!(f, "user"),
            MessageRole::Assistant => write!(f, "assistant"),
        }
    }
}

impl std::str::FromStr for MessageRole {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "user" => Ok(MessageRole::User),
            "assistant" => Ok(MessageRole::Assistant),
            _ => Err(format!("unknown role: {s}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageStatus {
    Created,
    Answering,
    Completed,
    Failed,
    Cancelled,
}

impl std::fmt::Display for MessageStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MessageStatus::Created => write!(f, "created"),
            MessageStatus::Answering => write!(f, "answering"),
            MessageStatus::Completed => write!(f, "completed"),
            MessageStatus::Failed => write!(f, "failed"),
            MessageStatus::Cancelled => write!(f, "cancelled"),
        }
    }
}

impl std::str::FromStr for MessageStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "created" => Ok(MessageStatus::Created),
            "answering" => Ok(MessageStatus::Answering),
            "completed" => Ok(MessageStatus::Completed),
            "failed" => Ok(MessageStatus::Failed),
            "cancelled" => Ok(MessageStatus::Cancelled),
            _ => Err(format!("unknown status: {s}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationStatus {
    Active,
    Archived,
    Deleted,
}

impl std::fmt::Display for ConversationStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConversationStatus::Active => write!(f, "active"),
            ConversationStatus::Archived => write!(f, "archived"),
            ConversationStatus::Deleted => write!(f, "deleted"),
        }
    }
}

impl std::str::FromStr for ConversationStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "active" => Ok(ConversationStatus::Active),
            "archived" => Ok(ConversationStatus::Archived),
            "deleted" => Ok(ConversationStatus::Deleted),
            _ => Err(format!("unknown conversation status: {s}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

pub fn now() -> DateTime<Utc> {
    Utc::now()
}
