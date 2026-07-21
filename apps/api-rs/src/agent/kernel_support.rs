use std::collections::HashMap;

use tokio::sync::mpsc::unbounded_channel;

use super::generator::AnswerStream;
use super::kernel::{AgentKernel, AgentProgress, PreparedAgentRequest};
use super::reasoner::{EvidenceObservation, ReactActionKind};
use crate::models::agent::{
    AgentRun, AgentTrace, AnswerStreamItem, ConversationTurn, PromptVersions, RuntimeComponents,
};
use crate::models::rag::RerankedChunk;
use crate::models::trace::{ResolvedRef, RetrievalPlan, RetrievalTrace};
use crate::models::{Confidence, NoAnswerReason, Usage};

pub(super) fn base_trace(prepared: &PreparedAgentRequest, kernel: &AgentKernel) -> AgentTrace {
    AgentTrace {
        mode: prepared.understanding.mode,
        mode_reason: "LLM semantic intent and response-mode decision".to_string(),
        rewritten_query: Some(prepared.understanding.standalone_query.clone()),
        keywords: prepared.understanding.keywords.clone(),
        resolved_refs: prepared
            .understanding
            .resolved_references
            .iter()
            .map(|reference| ResolvedRef {
                text: reference.text.clone(),
                resolved_to: reference.resolved_to.clone(),
                source_message_id: None,
                evidence_message_id: None,
            })
            .collect(),
        retrieval_plan: RetrievalPlan::default(),
        prompt_versions: PromptVersions {
            persona: "persona-v3".to_string(),
            guardrail: "grounded-untrusted-evidence-v19".to_string(),
            mode: format!("mode-{}-llm-v19", prepared.understanding.mode),
            task: "react-grounded-answer-v19".to_string(),
        },
        model: prepared.request.options.generation.model.clone(),
        usage: Some(Usage {
            input_tokens: 0,
            output_tokens: 0,
        }),
        started_at: prepared.started_at,
        memory_summary: prepared.understanding.memory_summary.clone(),
        react_steps: vec![],
        stop_reason: String::new(),
        runtime_components: RuntimeComponents {
            reasoner: kernel.reasoner.component_name(),
            retriever: kernel.retriever.component_name(),
            reranker: kernel.reranker.component_name(),
            verifier: kernel.claim_verifier.component_name(),
        },
        cache_key: None,
    }
}

pub(super) fn build_run(
    prepared: &PreparedAgentRequest,
    trace: AgentTrace,
    retrieval_plan: RetrievalPlan,
    retrieval_traces: Vec<RetrievalTrace>,
    answer_stream: AnswerStream,
    no_answer_reason: Option<NoAnswerReason>,
) -> AgentRun {
    AgentRun {
        assistant_message_id: prepared.request.assistant_message_id,
        mode: prepared.understanding.mode,
        rewritten_query: Some(prepared.understanding.standalone_query.clone()),
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

pub(super) fn evidence_observations(evidence: &[RerankedChunk]) -> Vec<EvidenceObservation> {
    evidence
        .iter()
        .enumerate()
        .map(|(index, item)| EvidenceObservation {
            evidence_id: index + 1,
            document: item.chunk.doc_title.clone(),
            location: if item.chunk.heading_path.is_empty() {
                format!("pages {:?}", item.chunk.page_range)
            } else {
                format!(
                    "{}; pages {:?}",
                    item.chunk.heading_path.join(" > "),
                    item.chunk.page_range
                )
            },
            content: item.chunk.content.chars().take(1_500).collect(),
            relevance_score: item.score,
        })
        .collect()
}

pub(super) fn merge_evidence(existing: &mut Vec<RerankedChunk>, incoming: Vec<RerankedChunk>) {
    let mut by_id = existing
        .drain(..)
        .map(|item| (item.chunk.chunk_id, item))
        .collect::<HashMap<_, _>>();
    for item in incoming {
        by_id
            .entry(item.chunk.chunk_id)
            .and_modify(|current| {
                if item.score > current.score {
                    *current = item.clone();
                }
            })
            .or_insert(item);
    }
    *existing = by_id.into_values().collect();
    existing.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

pub(super) fn action_name(action: &ReactActionKind) -> &'static str {
    match action {
        ReactActionKind::Search => "search",
        ReactActionKind::Finish => "finish",
        ReactActionKind::Clarify => "clarify",
    }
}

pub(super) fn emit(
    progress: &Option<tokio::sync::mpsc::UnboundedSender<AgentProgress>>,
    event: AgentProgress,
) {
    if let Some(tx) = progress {
        let _ = tx.send(event);
    }
}

pub(super) fn single_text_stream(text: String, confidence: Confidence) -> AnswerStream {
    let (tx, rx) = unbounded_channel();
    tokio::spawn(async move {
        let _ = tx.send(AnswerStreamItem::Delta { text: text.clone() });
        let _ = tx.send(AnswerStreamItem::Completed {
            confidence,
            usage: Some(Usage {
                input_tokens: 0,
                output_tokens: text.chars().count() as u32 / 2,
            }),
        });
    });
    rx
}
