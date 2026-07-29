use std::time::Duration;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct OpenAiClientConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub timeout_seconds: u64,
}

impl Default for OpenAiClientConfig {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:11434/v1".to_string(),
            api_key: "ollama".to_string(),
            model: "qwen2.5:14b".to_string(),
            timeout_seconds: 120,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: f64,
    pub max_tokens: u32,
    pub stream: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeltaChoice {
    #[serde(default)]
    pub index: i32,
    pub delta: Option<Value>,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StreamChunk {
    pub id: Option<String>,
    pub object: Option<String>,
    pub choices: Option<Vec<DeltaChoice>>,
}

#[derive(Debug, Clone)]
pub struct LlmStreamError {
    pub code: String,
    pub message: String,
}

impl LlmStreamError {
    pub fn provider(status: StatusCode, message: String) -> Self {
        let code = if status == StatusCode::UNAUTHORIZED {
            "LLM_UNAUTHORIZED"
        } else {
            "LLM_PROVIDER_ERROR"
        };
        Self {
            code: code.to_string(),
            message,
        }
    }

    pub fn stream(message: impl Into<String>) -> Self {
        Self {
            code: "LLM_STREAM_ERROR".to_string(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ParsedStreamEvent {
    Delta(String),
    Done,
    Error(String),
    Empty,
}

#[async_trait]
pub trait LlmClient: Send + Sync {
    async fn complete_json<T>(&self, prompt: String, system: Option<String>) -> Result<T>
    where
        T: serde::de::DeserializeOwned;

    async fn complete_json_with_options<T>(
        &self,
        prompt: String,
        system: Option<String>,
        temperature: f64,
        max_tokens: u32,
    ) -> Result<T>
    where
        T: serde::de::DeserializeOwned;

    async fn stream_text(
        &self,
        prompt: String,
        system: Option<String>,
        temperature: f64,
        max_tokens: u32,
    ) -> Result<tokio::sync::mpsc::UnboundedReceiver<Result<String, LlmStreamError>>>;

    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        temperature: f64,
        max_tokens: u32,
    ) -> Result<tokio::sync::mpsc::UnboundedReceiver<Result<String, LlmStreamError>>>;
}

pub struct OpenAiClient {
    pub(super) config: OpenAiClientConfig,
    pub(super) http: reqwest::Client,
}

impl OpenAiClient {
    pub fn new(config: OpenAiClientConfig) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_seconds))
            .build()?;
        Ok(Self { config, http })
    }

    pub(super) fn chat_url(&self) -> String {
        format!(
            "{}/chat/completions",
            self.config.base_url.trim_end_matches('/')
        )
    }

    pub(super) fn auth_header(&self) -> String {
        format!("Bearer {}", self.config.api_key)
    }

    async fn request_json<T>(
        &self,
        prompt: String,
        system: Option<String>,
        temperature: f64,
        max_tokens: u32,
    ) -> Result<T>
    where
        T: serde::de::DeserializeOwned,
    {
        let mut messages = vec![];
        if let Some(system) = system {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: system,
            });
        }
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: prompt,
        });
        let request = ChatCompletionRequest {
            model: self.config.model.clone(),
            messages,
            temperature,
            max_tokens,
            stream: false,
        };
        let response = self
            .http
            .post(self.chat_url())
            .header("Authorization", self.auth_header())
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await?
            .error_for_status()?;
        let payload: Value = response.json().await?;
        let content = payload["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| anyhow!("missing content in completion response"))?;
        parse_json_completion(content)
    }
}

#[async_trait]
impl LlmClient for OpenAiClient {
    async fn complete_json<T>(&self, prompt: String, system: Option<String>) -> Result<T>
    where
        T: serde::de::DeserializeOwned,
    {
        self.request_json(prompt, system, 0.2, 2048).await
    }

    async fn complete_json_with_options<T>(
        &self,
        prompt: String,
        system: Option<String>,
        temperature: f64,
        max_tokens: u32,
    ) -> Result<T>
    where
        T: serde::de::DeserializeOwned,
    {
        self.request_json(prompt, system, temperature, max_tokens)
            .await
    }

    async fn stream_text(
        &self,
        prompt: String,
        system: Option<String>,
        temperature: f64,
        max_tokens: u32,
    ) -> Result<tokio::sync::mpsc::UnboundedReceiver<Result<String, LlmStreamError>>> {
        let mut messages = vec![];
        if let Some(s) = system {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: s,
            });
        }
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: prompt,
        });

        self.stream_chat(messages, temperature, max_tokens).await
    }

    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        temperature: f64,
        max_tokens: u32,
    ) -> Result<tokio::sync::mpsc::UnboundedReceiver<Result<String, LlmStreamError>>> {
        let req = ChatCompletionRequest {
            model: self.config.model.clone(),
            messages,
            temperature,
            max_tokens,
            stream: true,
        };

        let resp = self
            .http
            .post(self.chat_url())
            .header("Authorization", self.auth_header())
            .header("Content-Type", "application/json")
            .json(&req)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp
                .text()
                .await
                .unwrap_or_else(|_| "LLM provider returned an unreadable error body".to_string());
            let message = provider_error_message(status, &body);
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            let _ = tx.send(Err(LlmStreamError::provider(status, message)));
            return Ok(rx);
        }

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let mut stream = resp.bytes_stream();

        tokio::spawn(async move {
            let mut buffer = String::new();
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some((pos, sep_len)) = find_sse_separator(&buffer) {
                            let event_text = buffer[..pos].to_string();
                            buffer = buffer[pos + sep_len..].to_string();
                            match parse_sse_event(&event_text) {
                                ParsedStreamEvent::Delta(text) => {
                                    let _ = tx.send(Ok(text));
                                }
                                ParsedStreamEvent::Error(message) => {
                                    let _ = tx.send(Err(LlmStreamError::stream(message)));
                                    return;
                                }
                                ParsedStreamEvent::Done => return,
                                ParsedStreamEvent::Empty => {}
                            }
                        }
                    }
                    Err(e) => {
                        tracing::error!("llm stream error: {e}");
                        let _ = tx.send(Err(LlmStreamError::stream(e.to_string())));
                        break;
                    }
                }
            }

            let rest = buffer.trim();
            if !rest.is_empty() {
                match parse_sse_event(rest) {
                    ParsedStreamEvent::Delta(text) => {
                        let _ = tx.send(Ok(text));
                    }
                    ParsedStreamEvent::Error(message) => {
                        let _ = tx.send(Err(LlmStreamError::stream(message)));
                    }
                    ParsedStreamEvent::Done | ParsedStreamEvent::Empty => {}
                }
            }
        });

        Ok(rx)
    }
}

fn find_sse_separator(buffer: &str) -> Option<(usize, usize)> {
    match (buffer.find("\n\n"), buffer.find("\r\n\r\n")) {
        (Some(a), Some(b)) if a < b => Some((a, 2)),
        (Some(_), Some(b)) => Some((b, 4)),
        (Some(a), None) => Some((a, 2)),
        (None, Some(b)) => Some((b, 4)),
        (None, None) => None,
    }
}

fn parse_sse_event(event_text: &str) -> ParsedStreamEvent {
    let mut data = String::new();
    for line in event_text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("data:") {
            let payload = trimmed.trim_start_matches("data:").trim();
            if payload == "[DONE]" {
                return ParsedStreamEvent::Done;
            }
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(payload);
        }
    }
    if data.is_empty() {
        return ParsedStreamEvent::Empty;
    }
    let value: Value = match serde_json::from_str(&data) {
        Ok(value) => value,
        Err(_) => return ParsedStreamEvent::Empty,
    };
    if let Some(message) = value
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
    {
        return ParsedStreamEvent::Error(message.to_string());
    }
    let chunk: StreamChunk = match serde_json::from_value(value) {
        Ok(chunk) => chunk,
        Err(_) => return ParsedStreamEvent::Empty,
    };
    let Some(choices) = chunk.choices else {
        return ParsedStreamEvent::Empty;
    };
    let Some(choice) = choices.first() else {
        return ParsedStreamEvent::Empty;
    };
    if choice.finish_reason.is_some() {
        return ParsedStreamEvent::Done;
    }
    let Some(delta) = choice.delta.as_ref() else {
        return ParsedStreamEvent::Empty;
    };
    delta["content"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| ParsedStreamEvent::Delta(s.to_string()))
        .unwrap_or(ParsedStreamEvent::Empty)
}

fn provider_error_message(status: StatusCode, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if let Some(message) = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
        {
            return format!("LLM provider returned {status}: {message}");
        }
        if let Some(message) = value.get("message").and_then(Value::as_str) {
            return format!("LLM provider returned {status}: {message}");
        }
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        format!("LLM provider returned {status}")
    } else {
        format!("LLM provider returned {status}: {trimmed}")
    }
}

fn strip_json_fences(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.starts_with("```json") && trimmed.ends_with("```") {
        let inner = trimmed
            .trim_start_matches("```json")
            .trim_end_matches("```");
        return inner.trim().to_string();
    }
    if trimmed.starts_with("```") && trimmed.ends_with("```") {
        let inner = trimmed.trim_start_matches("```").trim_end_matches("```");
        return inner.trim().to_string();
    }
    trimmed.to_string()
}

fn parse_json_completion<T>(text: &str) -> Result<T>
where
    T: serde::de::DeserializeOwned,
{
    let stripped = strip_json_fences(text);
    match serde_json::from_str(&stripped) {
        Ok(value) => Ok(value),
        Err(original_error) => {
            let repaired = escape_control_characters_in_json_strings(&stripped);
            serde_json::from_str(&repaired).map_err(|repaired_error| {
                anyhow!(
                    "invalid JSON completion: {original_error}; control-character repair also failed: {repaired_error}"
                )
            })
        }
    }
}

fn escape_control_characters_in_json_strings(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    for character in text.chars() {
        if !in_string {
            output.push(character);
            if character == '"' {
                in_string = true;
            }
            continue;
        }
        if escaped {
            output.push(character);
            escaped = false;
            continue;
        }
        match character {
            '\\' => {
                output.push(character);
                escaped = true;
            }
            '"' => {
                output.push(character);
                in_string = false;
            }
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            '\u{0008}' => output.push_str("\\b"),
            '\u{000C}' => output.push_str("\\f"),
            control if control <= '\u{001F}' => {
                output.push_str(&format!("\\u{:04X}", control as u32));
            }
            _ => output.push(character),
        }
    }
    output
}

use futures::StreamExt;

#[cfg(test)]
#[path = "openai_tests.rs"]
mod tests;
