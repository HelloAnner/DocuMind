use std::collections::HashMap;

use tokio::sync::mpsc::unbounded_channel;

use super::kernel::{AgentKernel, PreparedAgentRequest};
use super::model::{AgentMessage, AgentToolCall};
use super::stream::AnswerStream;
use super::tools::{KnowledgeSearchEffect, TerminalToolEffect, ToolEffect};
use crate::models::agent::{
    AgentMode, AgentRun, AgentTrace, AnswerStreamItem, ConversationTurn, PromptVersions,
    ReactStepTrace, ReactToolCallTrace, RuntimeComponents,
};
use crate::models::rag::RerankedChunk;
use crate::models::trace::{PlanMode, ResolvedRef, RetrievalPlan, RetrievalTrace};
use crate::models::{now, Confidence, Usage};
use uuid::Uuid;

pub(super) fn base_trace(prepared: &PreparedAgentRequest, kernel: &AgentKernel) -> AgentTrace {
    let search_component = kernel.knowledge_search_component.clone();
    AgentTrace {
        mode: prepared.mode,
        mode_reason: "model-native semantic tool selection".to_string(),
        rewritten_query: Some(prepared.request.original_query.clone()),
        keywords: Vec::new(),
        resolved_refs: Vec::<ResolvedRef>::new(),
        retrieval_plan: RetrievalPlan::default(),
        prompt_versions: PromptVersions {
            persona: prepared.prompt.persona_version.clone(),
            guardrail: prepared.prompt.guardrail_version.clone(),
            mode: prepared.prompt.mode_version.clone(),
            task: prepared.prompt.task_version.clone(),
        },
        model: prepared.request.options.generation.model.clone(),
        usage: Some(Usage {
            input_tokens: 0,
            output_tokens: 0,
        }),
        started_at: prepared.started_at,
        memory_summary: String::new(),
        react_steps: Vec::new(),
        stop_reason: String::new(),
        runtime_components: RuntimeComponents {
            reasoner: kernel.model.component_name(),
            retriever: search_component.clone(),
            reranker: search_component,
            verifier: kernel.answer_finalizer.component_name(),
        },
        cache_key: None,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_run(
    prepared: &PreparedAgentRequest,
    mode: AgentMode,
    rewritten_query: String,
    trace: AgentTrace,
    retrieval_plan: RetrievalPlan,
    retrieval_traces: Vec<RetrievalTrace>,
    answer_stream: AnswerStream,
    no_answer_reason: Option<crate::models::NoAnswerReason>,
) -> AgentRun {
    AgentRun {
        assistant_message_id: prepared.request.assistant_message_id,
        mode,
        rewritten_query: Some(rewritten_query),
        retrieval_plan,
        retrieval_traces,
        answer_stream,
        trace,
        no_answer_reason,
    }
}

pub(super) fn bounded_history(
    history: &[ConversationTurn],
    max_turns: usize,
    max_chars: usize,
) -> Vec<ConversationTurn> {
    let mut selected = Vec::new();
    let mut used = 0usize;
    for turn in history.iter().rev().take(max_turns.max(1)) {
        let size = turn.user_message.chars().count()
            + turn.assistant_answer.chars().count()
            + turn
                .citations
                .iter()
                .map(|item| item.chars().count())
                .sum::<usize>();
        if !selected.is_empty() && used.saturating_add(size) > max_chars.max(1) {
            break;
        }
        used = used.saturating_add(size);
        selected.push(turn.clone());
    }
    selected.reverse();
    selected
}

pub(super) fn build_messages(prepared: &PreparedAgentRequest) -> Vec<AgentMessage> {
    let mut messages = vec![AgentMessage::system(prepared.prompt.system_text.clone())];
    for turn in &prepared.bounded_history {
        messages.push(AgentMessage::user(turn.user_message.clone()));
        messages.push(AgentMessage::assistant(turn.assistant_answer.clone()));
    }
    messages.push(AgentMessage::user(prepared.request.original_query.clone()));
    messages
}

pub(super) fn merge_evidence_stable(
    existing: &mut Vec<RerankedChunk>,
    incoming: Vec<RerankedChunk>,
    max_context_chars: usize,
) -> Vec<usize> {
    let mut by_id = existing
        .iter()
        .enumerate()
        .map(|(index, item)| (item.chunk.chunk_id, index))
        .collect::<HashMap<_, _>>();
    let mut used_chars = existing
        .iter()
        .map(|item| item.chunk.content.chars().count())
        .sum::<usize>();
    let mut ids = Vec::new();
    for item in incoming {
        if let Some(index) = by_id.get(&item.chunk.chunk_id).copied() {
            if item.score > existing[index].score {
                existing[index] = item;
            }
            ids.push(index + 1);
            continue;
        }
        let chars = item.chunk.content.chars().count();
        if !existing.is_empty() && used_chars.saturating_add(chars) > max_context_chars.max(1) {
            continue;
        }
        used_chars = used_chars.saturating_add(chars);
        existing.push(item);
        let index = existing.len() - 1;
        by_id.insert(existing[index].chunk.chunk_id, index);
        ids.push(index + 1);
    }
    ids.sort_unstable();
    ids.dedup();
    ids
}

pub(super) fn model_evidence_payload(
    evidence: &[RerankedChunk],
    ids: &[usize],
) -> Vec<serde_json::Value> {
    ids.iter()
        .filter_map(|id| {
            let item = id.checked_sub(1).and_then(|index| evidence.get(index))?;
            Some(serde_json::json!({
                "id": id,
                "document": item.chunk.doc_title,
                "heading_path": item.chunk.heading_path,
                "pages": item.chunk.page_range,
                "content": item.chunk.content,
                "relevance_score": item.score
            }))
        })
        .collect()
}

pub(super) fn tool_arguments_value(arguments_json: &str) -> serde_json::Value {
    match serde_json::from_str(arguments_json) {
        Ok(value) => value,
        Err(_) => serde_json::json!({"raw_arguments": arguments_json}),
    }
}

pub(super) fn single_text_stream(
    text: String,
    confidence: Confidence,
    usage: Option<Usage>,
) -> AnswerStream {
    let (sender, receiver) = unbounded_channel();
    let output_tokens = text.chars().count() as u32 / 2;
    tokio::spawn(async move {
        let _ = sender.send(AnswerStreamItem::Replace { text });
        let _ = sender.send(AnswerStreamItem::Completed {
            confidence,
            usage: usage.or(Some(Usage {
                input_tokens: 0,
                output_tokens,
            })),
        });
    });
    receiver
}

pub(super) struct ToolState<'a> {
    pub evidence: &'a mut Vec<RerankedChunk>,
    pub retrieval_traces: &'a mut Vec<RetrievalTrace>,
    pub plan: &'a mut RetrievalPlan,
    pub keywords: &'a mut Vec<String>,
    pub resolved_refs: &'a mut Vec<ResolvedRef>,
    pub mode: &'a mut AgentMode,
    pub rewritten_query: &'a mut String,
    pub max_context_chars: usize,
}

#[derive(Debug, Default)]
pub(super) struct AppliedToolTrace {
    pub queries: Vec<String>,
    pub rerank_query: Option<String>,
    pub hypothetical_answer: Option<String>,
    pub retrieved_chunk_ids: Vec<Uuid>,
    pub accepted_chunk_ids: Vec<Uuid>,
    pub warnings: Vec<String>,
}

pub(super) struct AppliedToolEffect {
    pub model_result: serde_json::Value,
    pub public_result: serde_json::Value,
    pub terminal: Option<TerminalToolEffect>,
    pub document_search_attempted: bool,
    pub trace: AppliedToolTrace,
}

pub(super) fn apply_tool_effect(
    effect: ToolEffect,
    model_result: serde_json::Value,
    public_result: serde_json::Value,
    state: ToolState<'_>,
) -> AppliedToolEffect {
    match effect {
        ToolEffect::None => AppliedToolEffect {
            model_result,
            public_result,
            terminal: None,
            document_search_attempted: false,
            trace: AppliedToolTrace::default(),
        },
        ToolEffect::KnowledgeSearch(search) => apply_search_effect(search, state),
        ToolEffect::Terminal(terminal) => AppliedToolEffect {
            model_result,
            public_result,
            terminal: Some(terminal),
            document_search_attempted: false,
            trace: AppliedToolTrace::default(),
        },
    }
}

fn apply_search_effect(search: KnowledgeSearchEffect, state: ToolState<'_>) -> AppliedToolEffect {
    let KnowledgeSearchEffect {
        chunks,
        retrieval_traces,
        retrieved_chunk_ids,
        queries,
        rerank_query,
        hypothetical_answer,
        keywords,
        resolved_refs,
        warnings,
        mode,
    } = search;
    let trace_queries = queries
        .iter()
        .map(|query| query.query.clone())
        .collect::<Vec<_>>();
    let evidence_ids = merge_evidence_stable(state.evidence, chunks, state.max_context_chars);
    state.retrieval_traces.extend(retrieval_traces);
    state.plan.queries.extend(queries);
    state.plan.mode = if state.plan.queries.len() > 1 {
        PlanMode::Multi
    } else {
        PlanMode::Single
    };
    merge_unique_strings(state.keywords, keywords);
    merge_resolved_refs(state.resolved_refs, resolved_refs);
    if let Some(search_mode) = mode {
        *state.mode = search_mode;
    }
    *state.rewritten_query = rerank_query.clone();
    let observations = model_evidence_payload(state.evidence, &evidence_ids);
    let accepted_chunk_ids = evidence_ids
        .iter()
        .filter_map(|id| {
            id.checked_sub(1)
                .and_then(|index| state.evidence.get(index))
                .map(|item| item.chunk.chunk_id)
        })
        .collect::<Vec<_>>();
    AppliedToolEffect {
        model_result: serde_json::json!({
            "status": if observations.is_empty() { "no_relevant_evidence" } else { "evidence_ready" },
            "rerank_query": rerank_query,
            "hypothetical_answer_used": hypothetical_answer.is_some(),
            "document_evidence": observations,
            "warnings": warnings.clone()
        }),
        public_result: serde_json::json!({
            "accepted_evidence_ids": evidence_ids,
            "accumulated_evidence_count": state.evidence.len(),
            "warnings": warnings.clone()
        }),
        terminal: None,
        document_search_attempted: true,
        trace: AppliedToolTrace {
            queries: trace_queries,
            rerank_query: Some(state.rewritten_query.clone()),
            hypothetical_answer,
            retrieved_chunk_ids,
            accepted_chunk_ids,
            warnings,
        },
    }
}

fn merge_unique_strings(existing: &mut Vec<String>, incoming: Vec<String>) {
    for item in incoming {
        if !item.trim().is_empty() && !existing.contains(&item) {
            existing.push(item);
        }
    }
}

fn merge_resolved_refs(existing: &mut Vec<ResolvedRef>, incoming: Vec<ResolvedRef>) {
    for item in incoming {
        let duplicate = existing.iter().any(|candidate| {
            candidate.text == item.text && candidate.resolved_to == item.resolved_to
        });
        if !duplicate {
            existing.push(item);
        }
    }
}

pub(super) fn tool_step_summary(calls: &[AgentToolCall]) -> String {
    format!(
        "model selected tools: {}",
        calls
            .iter()
            .map(|call| call.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    )
}

pub(super) fn successful_tool_step(
    step: usize,
    call: &AgentToolCall,
    arguments: serde_json::Value,
    result: serde_json::Value,
    output: Option<&str>,
    details: &AppliedToolTrace,
    started_at: chrono::DateTime<chrono::Utc>,
) -> ReactStepTrace {
    let completed_at = now();
    ReactStepTrace {
        step,
        action: call.name.clone(),
        decision_summary: format!("executed {}", call.name),
        output: output.map(str::to_string),
        tool_calls: vec![ReactToolCallTrace {
            id: call.id.clone(),
            name: call.name.clone(),
            arguments,
            status: "succeeded".to_string(),
            result: Some(result),
            error: None,
            started_at,
            completed_at,
            duration_ms: completed_at
                .signed_duration_since(started_at)
                .num_milliseconds()
                .max(0) as u64,
        }],
        queries: details.queries.clone(),
        rerank_query: details.rerank_query.clone(),
        hypothetical_answer: details.hypothetical_answer.clone(),
        retrieved_chunk_ids: details.retrieved_chunk_ids.clone(),
        accepted_chunk_ids: details.accepted_chunk_ids.clone(),
        warnings: details.warnings.clone(),
        started_at,
        completed_at,
    }
}

pub(super) fn failed_tool_step(
    step: usize,
    call: &AgentToolCall,
    arguments: serde_json::Value,
    error: serde_json::Value,
    output: Option<&str>,
    message: &str,
    started_at: chrono::DateTime<chrono::Utc>,
) -> ReactStepTrace {
    let completed_at = now();
    ReactStepTrace {
        step,
        action: call.name.clone(),
        decision_summary: format!("{} failed", call.name),
        output: output.map(str::to_string),
        tool_calls: vec![ReactToolCallTrace {
            id: call.id.clone(),
            name: call.name.clone(),
            arguments,
            status: "failed".to_string(),
            result: None,
            error: Some(error),
            started_at,
            completed_at,
            duration_ms: completed_at
                .signed_duration_since(started_at)
                .num_milliseconds()
                .max(0) as u64,
        }],
        queries: Vec::new(),
        rerank_query: None,
        hypothetical_answer: None,
        retrieved_chunk_ids: Vec::new(),
        accepted_chunk_ids: Vec::new(),
        warnings: vec![message.to_string()],
        started_at,
        completed_at,
    }
}

pub(super) fn response_step(step: usize, content: &str) -> ReactStepTrace {
    let timestamp = now();
    ReactStepTrace {
        step,
        action: "respond".to_string(),
        decision_summary: format!("final response ({} chars)", content.chars().count()),
        output: Some(content.to_string()),
        tool_calls: Vec::new(),
        queries: Vec::new(),
        rerank_query: None,
        hypothetical_answer: None,
        retrieved_chunk_ids: Vec::new(),
        accepted_chunk_ids: Vec::new(),
        warnings: Vec::new(),
        started_at: timestamp,
        completed_at: timestamp,
    }
}

pub(super) fn failed_response_step(step: usize, content: &str, message: &str) -> ReactStepTrace {
    let timestamp = now();
    ReactStepTrace {
        step,
        action: "respond".to_string(),
        decision_summary: "response rejected".to_string(),
        output: Some(content.to_string()),
        tool_calls: Vec::new(),
        queries: Vec::new(),
        rerank_query: None,
        hypothetical_answer: None,
        retrieved_chunk_ids: Vec::new(),
        accepted_chunk_ids: Vec::new(),
        warnings: vec![message.to_string()],
        started_at: timestamp,
        completed_at: timestamp,
    }
}

#[cfg(test)]
mod tests {
    use super::{bounded_history, successful_tool_step, AppliedToolTrace};
    use crate::agent::model::AgentToolCall;
    use crate::models::agent::ConversationTurn;
    use crate::models::now;
    use serde_json::json;

    #[test]
    fn bounded_history_keeps_recent_turns() {
        let history = vec![
            ConversationTurn {
                user_message: "old".to_string(),
                assistant_answer: "old answer".to_string(),
                citations: Vec::new(),
            },
            ConversationTurn {
                user_message: "new".to_string(),
                assistant_answer: "new answer".to_string(),
                citations: Vec::new(),
            },
        ];
        let selected = bounded_history(&history, 1, 1_000);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].user_message, "new");
    }

    #[test]
    fn successful_tool_step_preserves_public_call_details() {
        let call = AgentToolCall {
            id: "call-1".to_string(),
            name: "knowledge_search".to_string(),
            arguments_json: r#"{"query":"DocuMind 架构"}"#.to_string(),
        };
        let arguments = json!({"query": "DocuMind 架构"});
        let public_result = json!({
            "matches": [{
                "document": "架构说明",
                "content": "Rust API 与 Next.js 前端"
            }]
        });
        let step = successful_tool_step(
            2,
            &call,
            arguments.clone(),
            public_result.clone(),
            Some("需要检索架构文档"),
            &AppliedToolTrace::default(),
            now(),
        );

        assert_eq!(step.step, 2);
        assert_eq!(step.output.as_deref(), Some("需要检索架构文档"));
        assert_eq!(step.tool_calls.len(), 1);
        assert_eq!(step.tool_calls[0].id, "call-1");
        assert_eq!(step.tool_calls[0].arguments, arguments);
        assert_eq!(step.tool_calls[0].result, Some(public_result));
        assert_eq!(step.tool_calls[0].status, "succeeded");
        assert!(step.tool_calls[0].error.is_none());
    }
}
