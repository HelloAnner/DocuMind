use std::time::Duration;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
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

#[async_trait]
pub trait LlmClient: Send + Sync {
    async fn complete_json<T>(&self, prompt: String, system: Option<String>) -> Result<T>
    where
        T: serde::de::DeserializeOwned;

    async fn stream_text(
        &self,
        prompt: String,
        system: Option<String>,
        temperature: f64,
        max_tokens: u32,
    ) -> Result<tokio::sync::mpsc::UnboundedReceiver<String>>;
}

pub struct OpenAiClient {
    config: OpenAiClientConfig,
    http: reqwest::Client,
}

impl OpenAiClient {
    pub fn new(config: OpenAiClientConfig) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_seconds))
            .build()?;
        Ok(Self { config, http })
    }

    fn chat_url(&self) -> String {
        format!(
            "{}/chat/completions",
            self.config.base_url.trim_end_matches('/')
        )
    }

    fn auth_header(&self) -> String {
        format!("Bearer {}", self.config.api_key)
    }
}

#[async_trait]
impl LlmClient for OpenAiClient {
    async fn complete_json<T>(&self, prompt: String, system: Option<String>) -> Result<T>
    where
        T: serde::de::DeserializeOwned,
    {
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

        let req = ChatCompletionRequest {
            model: self.config.model.clone(),
            messages,
            temperature: 0.2,
            max_tokens: 2048,
            stream: false,
        };

        let resp = self
            .http
            .post(self.chat_url())
            .header("Authorization", self.auth_header())
            .header("Content-Type", "application/json")
            .json(&req)
            .send()
            .await?
            .error_for_status()?;

        let json: Value = resp.json().await?;
        let content = json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| anyhow!("missing content in completion response"))?;

        // Some providers wrap JSON in markdown fences; strip them.
        let cleaned = strip_json_fences(content);
        Ok(serde_json::from_str(&cleaned)?)
    }

    async fn stream_text(
        &self,
        prompt: String,
        system: Option<String>,
        temperature: f64,
        max_tokens: u32,
    ) -> Result<tokio::sync::mpsc::UnboundedReceiver<String>> {
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
            .await?
            .error_for_status()?;

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let mut stream = resp.bytes_stream();

        tokio::spawn(async move {
            let mut buffer = String::new();
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(pos) = buffer.find("\n\n") {
                            let event = buffer.split_off(pos);
                            buffer.truncate(buffer.len() - pos); // keep remaining in buffer
                            let _ = buffer;
                            // Actually we need to split properly.
                            // Simpler: take the prefix before "\n\n".
                            let event_text = std::mem::take(&mut buffer);
                            buffer = event;
                            buffer = buffer.trim_start_matches("\n\n").to_string();
                            if let Some(text) = parse_sse_event(&event_text) {
                                let _ = tx.send(text);
                            }
                        }
                    }
                    Err(e) => {
                        tracing::error!("llm stream error: {e}");
                        break;
                    }
                }
            }
        });

        Ok(rx)
    }
}

fn parse_sse_event(event_text: &str) -> Option<String> {
    let mut data = String::new();
    for line in event_text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("data:") {
            let payload = trimmed.trim_start_matches("data:").trim();
            if payload == "[DONE]" {
                return None;
            }
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(payload);
        }
    }
    if data.is_empty() {
        return None;
    }
    let chunk: StreamChunk = serde_json::from_str(&data).ok()?;
    let choices = chunk.choices?;
    let choice = choices.first()?;
    if choice.finish_reason.is_some() {
        return None;
    }
    let delta = choice.delta.as_ref()?;
    delta["content"].as_str().map(|s| s.to_string())
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

use futures::StreamExt;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_json_fences() {
        let raw = "```json\n{\"a\":1}\n```";
        assert_eq!(super::strip_json_fences(raw), "{\"a\":1}");
    }

    #[test]
    fn parses_sse_data_line() {
        let event = "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}";
        assert_eq!(parse_sse_event(event), Some("hello".to_string()));
    }
}
