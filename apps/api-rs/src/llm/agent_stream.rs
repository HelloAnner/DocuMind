use std::collections::BTreeMap;

use anyhow::{anyhow, Result};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::agent::model::{AgentModelResponse, AgentModelStreamEvent, AgentToolCall};
use crate::models::Usage;

#[derive(Debug, Default)]
struct PendingToolCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Default)]
pub(super) struct AgentStreamState {
    content: String,
    tool_calls: BTreeMap<usize, PendingToolCall>,
    usage: Option<Usage>,
    finish_reason: Option<String>,
}

impl AgentStreamState {
    pub(super) fn into_response(self) -> Result<AgentModelResponse> {
        let tool_calls = self
            .tool_calls
            .into_values()
            .map(|call| {
                if call.id.is_empty() {
                    return Err(anyhow!("streamed tool call is missing id"));
                }
                if call.name.is_empty() {
                    return Err(anyhow!("streamed tool call is missing name"));
                }
                Ok(AgentToolCall {
                    id: call.id,
                    name: call.name,
                    arguments_json: if call.arguments.is_empty() {
                        "{}".to_string()
                    } else {
                        call.arguments
                    },
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let content = (!self.content.is_empty()).then_some(self.content);
        if content.is_none() && tool_calls.is_empty() {
            return Err(anyhow!(
                "agent stream completed without content or tool calls"
            ));
        }
        Ok(AgentModelResponse {
            content,
            tool_calls,
            usage: self.usage,
            finish_reason: self.finish_reason,
        })
    }
}

pub(super) fn find_stream_separator(buffer: &str) -> Option<(usize, usize)> {
    match (buffer.find("\n\n"), buffer.find("\r\n\r\n")) {
        (Some(unix), Some(windows)) if unix < windows => Some((unix, 2)),
        (Some(_), Some(windows)) => Some((windows, 4)),
        (Some(unix), None) => Some((unix, 2)),
        (None, Some(windows)) => Some((windows, 4)),
        (None, None) => None,
    }
}

pub(super) fn apply_stream_frame(
    frame: &str,
    state: &mut AgentStreamState,
    events: Option<&UnboundedSender<AgentModelStreamEvent>>,
) -> Result<bool> {
    let mut data = String::new();
    for line in frame.lines() {
        let trimmed = line.trim();
        let Some(value) = trimmed.strip_prefix("data:") else {
            continue;
        };
        let value = value.trim();
        if value == "[DONE]" {
            return Ok(true);
        }
        if !data.is_empty() {
            data.push('\n');
        }
        data.push_str(value);
    }
    if data.is_empty() {
        return Ok(false);
    }

    let payload: Value = serde_json::from_str(&data)?;
    if let Some(message) = payload
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
    {
        return Err(anyhow!("agent stream provider error: {message}"));
    }
    if let Some(usage) = payload.get("usage").and_then(Value::as_object) {
        state.usage = Some(Usage {
            input_tokens: usage
                .get("prompt_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32,
            output_tokens: usage
                .get("completion_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32,
        });
    }
    let Some(choice) = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    else {
        return Ok(false);
    };
    if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
        state.finish_reason = Some(reason.to_string());
    }
    let Some(delta) = choice.get("delta").and_then(Value::as_object) else {
        return Ok(false);
    };

    forward_text_delta(
        delta.get("content").and_then(Value::as_str),
        &mut state.content,
        events,
        AgentModelStreamEvent::ResponseDelta,
    );
    let thinking = delta
        .get("reasoning_content")
        .or_else(|| delta.get("reasoning"))
        .and_then(Value::as_str);
    forward_event_delta(thinking, events, AgentModelStreamEvent::ThinkingDelta);
    apply_tool_call_deltas(delta.get("tool_calls"), &mut state.tool_calls);
    Ok(false)
}

fn forward_text_delta(
    delta: Option<&str>,
    content: &mut String,
    events: Option<&UnboundedSender<AgentModelStreamEvent>>,
    event: fn(String) -> AgentModelStreamEvent,
) {
    let Some(delta) = delta.filter(|value| !value.is_empty()) else {
        return;
    };
    content.push_str(delta);
    send_stream_event(events, event(delta.to_string()));
}

fn forward_event_delta(
    delta: Option<&str>,
    events: Option<&UnboundedSender<AgentModelStreamEvent>>,
    event: fn(String) -> AgentModelStreamEvent,
) {
    let Some(delta) = delta.filter(|value| !value.is_empty()) else {
        return;
    };
    send_stream_event(events, event(delta.to_string()));
}

fn apply_tool_call_deltas(
    tool_calls: Option<&Value>,
    pending_calls: &mut BTreeMap<usize, PendingToolCall>,
) {
    let Some(tool_calls) = tool_calls.and_then(Value::as_array) else {
        return;
    };
    for (fallback_index, tool_call) in tool_calls.iter().enumerate() {
        let index = tool_call
            .get("index")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(fallback_index);
        let pending = pending_calls.entry(index).or_default();
        if let Some(id) = tool_call.get("id").and_then(Value::as_str) {
            append_stream_fragment(&mut pending.id, id);
        }
        if let Some(function) = tool_call.get("function").and_then(Value::as_object) {
            if let Some(name) = function.get("name").and_then(Value::as_str) {
                append_stream_fragment(&mut pending.name, name);
            }
            if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                pending.arguments.push_str(arguments);
            }
        }
    }
}

fn append_stream_fragment(target: &mut String, fragment: &str) {
    if fragment.is_empty() || target == fragment {
        return;
    }
    target.push_str(fragment);
}

fn send_stream_event(
    events: Option<&UnboundedSender<AgentModelStreamEvent>>,
    event: AgentModelStreamEvent,
) {
    if let Some(events) = events {
        let _ = events.send(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streamed_content_and_thinking_are_forwarded_incrementally() {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let mut state = AgentStreamState::default();
        apply_stream_frame(
            r#"data: {"choices":[{"delta":{"reasoning_content":"先检索","content":"合同"},"finish_reason":null}]}"#,
            &mut state,
            Some(&sender),
        )
        .expect("stream frame should parse");
        apply_stream_frame(
            r#"data: {"choices":[{"delta":{"content":"结论"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}"#,
            &mut state,
            Some(&sender),
        )
        .expect("stream frame should parse");

        assert_eq!(
            receiver.try_recv().expect("content delta"),
            AgentModelStreamEvent::ResponseDelta("合同".to_string())
        );
        assert_eq!(
            receiver.try_recv().expect("thinking delta"),
            AgentModelStreamEvent::ThinkingDelta("先检索".to_string())
        );
        assert_eq!(
            receiver.try_recv().expect("response delta"),
            AgentModelStreamEvent::ResponseDelta("结论".to_string())
        );
        let response = state.into_response().expect("stream should complete");
        assert_eq!(response.content.as_deref(), Some("合同结论"));
        assert_eq!(response.finish_reason.as_deref(), Some("stop"));
        assert_eq!(response.usage.expect("usage").output_tokens, 3);
    }

    #[test]
    fn streamed_tool_call_fragments_are_assembled_by_index() {
        let mut state = AgentStreamState::default();
        apply_stream_frame(
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"knowledge_","arguments":"{\"queries\":[\"合"}}]},"finish_reason":null}]}"#,
            &mut state,
            None,
        )
        .expect("first tool frame should parse");
        apply_stream_frame(
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"search","arguments":"同\"]}"}}]},"finish_reason":"tool_calls"}]}"#,
            &mut state,
            None,
        )
        .expect("second tool frame should parse");

        let response = state.into_response().expect("tool stream should complete");
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].id, "call-1");
        assert_eq!(response.tool_calls[0].name, "knowledge_search");
        assert_eq!(
            response.tool_calls[0].arguments_json,
            "{\"queries\":[\"合同\"]}"
        );
    }
}
