use anyhow::{anyhow, Result};
use async_trait::async_trait;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use super::agent_stream::{apply_stream_frame, find_stream_separator, AgentStreamState};
use super::OpenAiClient;
use crate::agent::model::{
    AgentMessage, AgentMessageRole, AgentModel, AgentModelRequest, AgentModelResponse,
    AgentModelStreamEvent, AgentToolCall, AgentToolDefinition,
};
use crate::models::Usage;

#[derive(Debug, Clone, Serialize)]
struct ToolChatFunction {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameters: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    arguments: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ToolChatCall {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    function: ToolChatFunction,
}

#[derive(Debug, Clone, Serialize)]
struct ToolChatMessage {
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<ToolChatCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ToolDefinitionRequest {
    #[serde(rename = "type")]
    kind: String,
    function: ToolChatFunction,
}

#[derive(Debug, Clone, Serialize)]
struct ToolChatCompletionRequest {
    model: String,
    messages: Vec<ToolChatMessage>,
    tools: Vec<ToolDefinitionRequest>,
    tool_choice: &'static str,
    temperature: f64,
    max_tokens: u32,
    stream: bool,
}

#[derive(Debug, Deserialize)]
struct ToolChatCompletionResponse {
    choices: Vec<ToolChatChoice>,
    usage: Option<ToolChatUsage>,
}

#[derive(Debug, Deserialize)]
struct ToolChatChoice {
    message: ToolChatResponseMessage,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ToolChatResponseMessage {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolChatResponseCall>,
}

#[derive(Debug, Deserialize)]
struct ToolChatResponseCall {
    id: String,
    function: ToolChatResponseFunction,
}

#[derive(Debug, Deserialize)]
struct ToolChatResponseFunction {
    name: String,
    arguments: String,
}

#[derive(Debug, Deserialize)]
struct ToolChatUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
}

#[async_trait]
impl AgentModel for OpenAiClient {
    async fn complete(&self, request: AgentModelRequest) -> Result<AgentModelResponse> {
        let payload = request_payload(&self.config.model, request, false)?;
        let response = self
            .http
            .post(self.chat_url())
            .header("Authorization", self.auth_header())
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await?
            .error_for_status()?;
        parse_response(response.json().await?)
    }

    async fn complete_streamed(
        &self,
        request: AgentModelRequest,
        events: Option<UnboundedSender<AgentModelStreamEvent>>,
    ) -> Result<AgentModelResponse> {
        let payload = request_payload(&self.config.model, request, true)?;
        let response = self
            .http
            .post(self.chat_url())
            .header("Authorization", self.auth_header())
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "unreadable provider error".to_string());
            return Err(anyhow!("agent stream provider returned {status}: {body}"));
        }

        let mut state = AgentStreamState::default();
        let mut bytes = response.bytes_stream();
        let mut buffer = String::new();
        let mut done = false;
        while !done {
            let Some(chunk) = bytes.next().await else {
                break;
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk?));
            while let Some((position, separator_length)) = find_stream_separator(&buffer) {
                let frame = buffer[..position].to_string();
                buffer = buffer[position + separator_length..].to_string();
                done = apply_stream_frame(&frame, &mut state, events.as_ref())?;
                if done {
                    break;
                }
            }
        }
        if !done && !buffer.trim().is_empty() {
            apply_stream_frame(buffer.trim(), &mut state, events.as_ref())?;
        }
        state.into_response()
    }

    fn component_name(&self) -> String {
        format!("openai-compatible-agent:{}", self.config.model)
    }
}

fn request_payload(
    model: &str,
    request: AgentModelRequest,
    stream: bool,
) -> Result<ToolChatCompletionRequest> {
    let messages = request
        .messages
        .into_iter()
        .map(tool_chat_message)
        .collect::<Result<Vec<_>>>()?;
    let tools = request
        .tools
        .into_iter()
        .map(tool_definition_request)
        .collect();
    Ok(ToolChatCompletionRequest {
        model: model.to_string(),
        messages,
        tools,
        tool_choice: "auto",
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        stream,
    })
}

fn parse_response(payload: ToolChatCompletionResponse) -> Result<AgentModelResponse> {
    let choice = payload
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("missing choice in agent completion response"))?;
    let tool_calls = choice
        .message
        .tool_calls
        .into_iter()
        .map(|call| AgentToolCall {
            id: call.id,
            name: call.function.name,
            arguments_json: call.function.arguments,
        })
        .collect();
    let usage = payload.usage.map(|usage| Usage {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
    });
    Ok(AgentModelResponse {
        content: choice.message.content,
        tool_calls,
        usage,
        finish_reason: choice.finish_reason,
    })
}

fn tool_chat_message(message: AgentMessage) -> Result<ToolChatMessage> {
    let role = match message.role {
        AgentMessageRole::System => "system",
        AgentMessageRole::User => "user",
        AgentMessageRole::Assistant => "assistant",
        AgentMessageRole::Tool => "tool",
    }
    .to_string();
    if message.role == AgentMessageRole::Tool && message.tool_call_id.is_none() {
        return Err(anyhow!("tool message is missing tool_call_id"));
    }
    let tool_calls = message
        .tool_calls
        .into_iter()
        .map(|call| ToolChatCall {
            id: call.id,
            kind: "function".to_string(),
            function: ToolChatFunction {
                name: call.name,
                description: None,
                parameters: None,
                arguments: Some(call.arguments_json),
            },
        })
        .collect();
    Ok(ToolChatMessage {
        role,
        content: message.content,
        tool_calls,
        tool_call_id: message.tool_call_id,
    })
}

fn tool_definition_request(definition: AgentToolDefinition) -> ToolDefinitionRequest {
    ToolDefinitionRequest {
        kind: "function".to_string(),
        function: ToolChatFunction {
            name: definition.name,
            description: Some(definition.description),
            parameters: Some(definition.parameters),
            arguments: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::model::{AgentMessage, AgentToolDefinition};

    #[test]
    fn request_uses_auto_tool_choice_and_preserves_tool_protocol() {
        let payload = request_payload(
            "qwen",
            AgentModelRequest {
                messages: vec![
                    AgentMessage::user("查合同"),
                    AgentMessage::assistant_with_tools(
                        None,
                        vec![AgentToolCall {
                            id: "call-1".to_string(),
                            name: "knowledge_search".to_string(),
                            arguments_json: "{\"queries\":[\"合同\"]}".to_string(),
                        }],
                    ),
                    AgentMessage::tool("call-1", "{\"status\":\"evidence_ready\"}"),
                ],
                tools: vec![AgentToolDefinition {
                    name: "knowledge_search".to_string(),
                    description: "search".to_string(),
                    parameters: serde_json::json!({"type": "object"}),
                }],
                temperature: 0.1,
                max_tokens: 800,
            },
            false,
        )
        .expect("request should serialize");
        let value = serde_json::to_value(payload).expect("payload should be JSON");
        assert_eq!(value["tool_choice"], "auto");
        assert_eq!(value["messages"][1]["tool_calls"][0]["id"], "call-1");
        assert_eq!(value["messages"][2]["tool_call_id"], "call-1");
        assert_eq!(value["tools"][0]["function"]["name"], "knowledge_search");
    }

    #[test]
    fn response_parses_native_tool_calls_and_usage() {
        let payload: ToolChatCompletionResponse = serde_json::from_value(serde_json::json!({
            "choices": [{
                "message": {
                    "content": null,
                    "tool_calls": [{
                        "id": "call-9",
                        "type": "function",
                        "function": {
                            "name": "knowledge_search",
                            "arguments": "{\"queries\":[\"制度\"]}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 12, "completion_tokens": 7}
        }))
        .expect("provider response should deserialize");
        let response = parse_response(payload).expect("response should parse");
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].name, "knowledge_search");
        assert_eq!(response.usage.expect("usage should exist").input_tokens, 12);
    }
}
