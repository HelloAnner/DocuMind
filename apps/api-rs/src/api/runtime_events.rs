use axum::http::HeaderMap;
use axum::response::sse::Event;
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::models::now;

pub const EVENT_PROTOCOL_HEADER: &str = "x-documind-event-protocol";
pub const ATOM_SCHEMA_VERSION: &str = "moss.execution.event.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SseProtocol {
    Legacy,
    Atom,
}

impl SseProtocol {
    pub fn from_headers(headers: &HeaderMap) -> Self {
        let requested = headers
            .get(EVENT_PROTOCOL_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::trim);

        match requested {
            Some("atom") | Some(ATOM_SCHEMA_VERSION) => SseProtocol::Atom,
            _ => SseProtocol::Legacy,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeStep {
    pub step_id: String,
    pub parent_step_id: Option<String>,
    pub step_type: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeEventEnvelope {
    pub schema_version: &'static str,
    pub event_id: String,
    pub job_id: Uuid,
    pub tenant_id: Uuid,
    pub user_id: Uuid,
    pub agent_id: String,
    pub session_id: Uuid,
    pub execution_id: Uuid,
    pub event_seq: u64,
    pub event_type: String,
    pub occurred_at: chrono::DateTime<chrono::Utc>,
    pub response_message_id: Uuid,
    pub trace_id: String,
    pub step: Option<RuntimeStep>,
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub struct RuntimeEventFactory {
    job_id: Uuid,
    tenant_id: Uuid,
    user_id: Uuid,
    session_id: Uuid,
    execution_id: Uuid,
    response_message_id: Uuid,
    trace_id: String,
    next_seq: u64,
}

impl RuntimeEventFactory {
    pub fn new(
        tenant_id: Uuid,
        user_id: Uuid,
        session_id: Uuid,
        response_message_id: Uuid,
    ) -> Self {
        let job_id = Uuid::new_v4();
        Self {
            job_id,
            tenant_id,
            user_id,
            session_id,
            execution_id: Uuid::new_v4(),
            response_message_id,
            trace_id: format!("trace_{job_id}"),
            next_seq: 1,
        }
    }

    pub fn event(&mut self, event_type: &str, payload: Value) -> Event {
        self.event_with_step(event_type, None, payload)
    }

    pub fn event_with_step(
        &mut self,
        event_type: &str,
        step: Option<RuntimeStep>,
        payload: Value,
    ) -> Event {
        let seq = self.next_seq;
        self.next_seq += 1;
        let envelope = RuntimeEventEnvelope {
            schema_version: ATOM_SCHEMA_VERSION,
            event_id: format!("evt_{}_{}", self.job_id.simple(), seq),
            job_id: self.job_id,
            tenant_id: self.tenant_id,
            user_id: self.user_id,
            agent_id: "documind_default".to_string(),
            session_id: self.session_id,
            execution_id: self.execution_id,
            event_seq: seq,
            event_type: event_type.to_string(),
            occurred_at: now(),
            response_message_id: self.response_message_id,
            trace_id: self.trace_id.clone(),
            step,
            payload,
        };

        Event::default()
            .event(event_type)
            .id(envelope.event_id.clone())
            .data(json!(envelope).to_string())
    }
}

pub fn tool_step(tool_call_id: &str, name: &str) -> RuntimeStep {
    RuntimeStep {
        step_id: tool_call_id.to_string(),
        parent_step_id: None,
        step_type: "ToolCall".to_string(),
        name: name.to_string(),
    }
}
