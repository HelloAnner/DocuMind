use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::models::Usage;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentMessageRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentToolCall {
    pub id: String,
    pub name: String,
    pub arguments_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMessage {
    pub role: AgentMessageRole,
    pub content: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<AgentToolCall>,
    pub tool_call_id: Option<String>,
}

impl AgentMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self::text(AgentMessageRole::System, content)
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self::text(AgentMessageRole::User, content)
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self::text(AgentMessageRole::Assistant, content)
    }

    pub fn assistant_with_tools(content: Option<String>, tool_calls: Vec<AgentToolCall>) -> Self {
        Self {
            role: AgentMessageRole::Assistant,
            content,
            tool_calls,
            tool_call_id: None,
        }
    }

    pub fn tool(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: AgentMessageRole::Tool,
            content: Some(content.into()),
            tool_calls: Vec::new(),
            tool_call_id: Some(tool_call_id.into()),
        }
    }

    fn text(role: AgentMessageRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: Some(content.into()),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone)]
pub struct AgentModelRequest {
    pub messages: Vec<AgentMessage>,
    pub tools: Vec<AgentToolDefinition>,
    pub temperature: f64,
    pub max_tokens: u32,
}

#[derive(Debug, Clone)]
pub struct AgentModelResponse {
    pub content: Option<String>,
    pub tool_calls: Vec<AgentToolCall>,
    pub usage: Option<Usage>,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentModelStreamEvent {
    ResponseDelta(String),
    ThinkingDelta(String),
}

impl AgentModelResponse {
    pub fn has_content(&self) -> bool {
        self.content
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty())
    }
}

#[async_trait::async_trait]
pub trait AgentModel: Send + Sync {
    async fn complete(&self, request: AgentModelRequest) -> Result<AgentModelResponse>;

    async fn complete_streamed(
        &self,
        request: AgentModelRequest,
        events: Option<UnboundedSender<AgentModelStreamEvent>>,
    ) -> Result<AgentModelResponse> {
        let response = self.complete(request).await?;
        if let (Some(sender), Some(content)) = (events, response.content.as_ref()) {
            if !content.is_empty() {
                let _ = sender.send(AgentModelStreamEvent::ResponseDelta(content.clone()));
            }
        }
        Ok(response)
    }

    fn component_name(&self) -> String;
}
