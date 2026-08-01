#[derive(Debug)]
pub enum AgentProgress {
    StatusUpdated {
        status: &'static str,
    },
    RewriteCompleted {
        rewritten_query: String,
        keywords: Vec<String>,
    },
    ReactStepStarted {
        step: usize,
        action: String,
        decision_summary: String,
    },
    ToolCallStarted {
        tool_call_id: String,
        name: String,
        arguments: serde_json::Value,
    },
    ToolCallCompleted {
        tool_call_id: String,
        name: String,
        result: serde_json::Value,
    },
    ToolCallFailed {
        tool_call_id: String,
        name: String,
        error: serde_json::Value,
    },
    RetrievalCompleted {
        chunk_count: usize,
        warnings: Vec<String>,
    },
    RerankCompleted {
        top_chunk_ids: Vec<uuid::Uuid>,
    },
    ResponseDelta {
        delta: String,
    },
    ResponseReset,
    ThinkingDelta {
        delta: String,
    },
    Flush {
        acknowledgement: tokio::sync::oneshot::Sender<()>,
    },
}

pub type ProgressSender = Option<tokio::sync::mpsc::UnboundedSender<AgentProgress>>;

pub fn emit(progress: &ProgressSender, event: AgentProgress) {
    if let Some(sender) = progress {
        let _ = sender.send(event);
    }
}
