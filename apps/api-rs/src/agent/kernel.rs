use std::sync::Arc;

use super::generator::AnswerGenerator;
use super::kernel_support::{
    action_name, base_trace, bounded_history, build_run, emit, evidence_observations,
    merge_evidence, single_text_stream,
};
use super::prompt::PromptRegistry;
use super::reasoner::{
    AgentReasoner, PreviousAction, QueryUnderstanding, ReactActionKind, ReactStateView,
};
use super::trace_builder::{reranked_traces, retrieved_traces};
use super::verifier::ClaimVerifier;
use crate::models::agent::{
    AgentRequest, AgentRun, ConversationTurn, PromptVersions, ReactStepTrace,
};
use crate::models::now;
use crate::models::rag::{ContextInput, RerankInput, RerankedChunk, RetrievalInput};
use crate::models::trace::{PlanMode, RetrievalPlan, RetrievalTrace, SubQuery};
use crate::models::{Confidence, NoAnswerReason};
use crate::rag::{ContextAssembler, Reranker, Retriever};
use anyhow::Result;

#[derive(Debug, Clone)]
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
    RetrievalCompleted {
        chunk_count: usize,
        warnings: Vec<String>,
    },
    RerankCompleted {
        top_chunk_ids: Vec<uuid::Uuid>,
    },
}

#[derive(Debug, Clone)]
pub struct PreparedAgentRequest {
    pub request: AgentRequest,
    pub understanding: QueryUnderstanding,
    pub bounded_history: Vec<ConversationTurn>,
    pub started_at: chrono::DateTime<chrono::Utc>,
}

impl PreparedAgentRequest {
    pub fn standalone_query(&self) -> &str {
        &self.understanding.standalone_query
    }

    pub fn context_fingerprint_input(&self) -> Result<String> {
        if !self.understanding.context_dependent {
            return Ok("context-independent".to_string());
        }
        Ok(serde_json::to_string(&serde_json::json!({
            "memory_summary": self.understanding.memory_summary,
            "history": self.bounded_history,
        }))?)
    }
}

#[derive(Clone)]
pub struct AgentKernel {
    pub reasoner: Arc<dyn AgentReasoner>,
    pub retriever: Arc<dyn Retriever>,
    pub reranker: Arc<dyn Reranker>,
    pub context_assembler: Arc<dyn ContextAssembler>,
    pub answer_generator: Arc<dyn AnswerGenerator>,
    pub prompt_registry: Arc<dyn PromptRegistry>,
    pub claim_verifier: Arc<dyn ClaimVerifier>,
}

impl AgentKernel {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        reasoner: Arc<dyn AgentReasoner>,
        retriever: Arc<dyn Retriever>,
        reranker: Arc<dyn Reranker>,
        context_assembler: Arc<dyn ContextAssembler>,
        answer_generator: Arc<dyn AnswerGenerator>,
        prompt_registry: Arc<dyn PromptRegistry>,
        claim_verifier: Arc<dyn ClaimVerifier>,
    ) -> Self {
        Self {
            reasoner,
            retriever,
            reranker,
            context_assembler,
            answer_generator,
            prompt_registry,
            claim_verifier,
        }
    }

    pub async fn prepare(&self, request: AgentRequest) -> Result<PreparedAgentRequest> {
        let started_at = now();
        let bounded_history = bounded_history(
            &request.history,
            request.options.runtime.max_history_turns,
            request.options.runtime.max_history_chars,
        );
        let understanding = self
            .reasoner
            .understand(
                &request.original_query,
                &bounded_history,
                request.options.allow_analyst_mode,
            )
            .await?;
        Ok(PreparedAgentRequest {
            request,
            understanding,
            bounded_history,
            started_at,
        })
    }

    pub async fn run(&self, request: AgentRequest) -> Result<AgentRun> {
        let prepared = self.prepare(request).await?;
        self.run_prepared(prepared, None).await
    }

    pub async fn run_prepared(
        &self,
        prepared: PreparedAgentRequest,
        progress: Option<tokio::sync::mpsc::UnboundedSender<AgentProgress>>,
    ) -> Result<AgentRun> {
        let request = &prepared.request;
        emit(
            &progress,
            AgentProgress::StatusUpdated {
                status: "understanding",
            },
        );
        emit(
            &progress,
            AgentProgress::RewriteCompleted {
                rewritten_query: prepared.understanding.standalone_query.clone(),
                keywords: prepared.understanding.keywords.clone(),
            },
        );

        let mut trace = base_trace(&prepared, self);
        let mut evidence = Vec::<RerankedChunk>::new();
        let mut previous_actions = Vec::<PreviousAction>::new();
        let mut react_steps = Vec::<ReactStepTrace>::new();
        let mut retrieval_traces = Vec::<RetrievalTrace>::new();
        let mut plan = RetrievalPlan::default();
        let mut answer_stream = None;
        let mut no_answer_reason = None;

        for step in 1..=request.options.runtime.max_react_steps.max(1) {
            let observations = evidence_observations(&evidence);
            let state = ReactStateView {
                original_query: &request.original_query,
                standalone_query: &prepared.understanding.standalone_query,
                mode: prepared.understanding.mode,
                response_strategy: &prepared.understanding.response_strategy,
                understanding_needs_clarification: prepared.understanding.needs_clarification,
                proposed_clarification_question: prepared
                    .understanding
                    .clarification_question
                    .as_deref(),
                evidence: &observations,
                previous_actions: &previous_actions,
                current_step: step,
                remaining_steps: request.options.runtime.max_react_steps.saturating_sub(step),
                max_queries_per_step: request.options.runtime.max_queries_per_step,
                hyde_enabled: request.options.runtime.hyde_enabled,
            };
            let decision = self.reasoner.decide(&state).await?;
            let action_name = action_name(&decision.action).to_string();
            emit(
                &progress,
                AgentProgress::ReactStepStarted {
                    step,
                    action: action_name.clone(),
                    decision_summary: decision.decision_summary.clone(),
                },
            );
            let step_started = now();

            match decision.action {
                ReactActionKind::Search => {
                    let search = decision
                        .search
                        .ok_or_else(|| anyhow::anyhow!("search decision has no parameters"))?;
                    let tool_call_id = format!("knowledge_search_{step}");
                    emit(
                        &progress,
                        AgentProgress::ToolCallStarted {
                            tool_call_id: tool_call_id.clone(),
                            name: "knowledge_search".to_string(),
                            arguments: serde_json::json!({
                                "queries": search.queries,
                                "rerank_query": search.rerank_query,
                                "uses_hyde": search.hypothetical_answer.is_some()
                                    && request.options.runtime.hyde_enabled,
                            }),
                        },
                    );
                    emit(
                        &progress,
                        AgentProgress::StatusUpdated {
                            status: "retrieving",
                        },
                    );
                    let retrieval = self
                        .retriever
                        .retrieve(RetrievalInput {
                            tenant_id: request.tenant_id,
                            effective_kb_ids: request.effective_kb_ids.clone(),
                            queries: search.queries.clone(),
                            hypothetical_answer: request
                                .options
                                .runtime
                                .hyde_enabled
                                .then_some(search.hypothetical_answer.clone())
                                .flatten(),
                            top_k: request.options.retrieval.rrf_top_k.max(1),
                            dense_top_k: request.options.retrieval.dense_top_k.max(1),
                            bm25_top_k: request.options.retrieval.bm25_top_k.max(1),
                        })
                        .await?;
                    let retrieval_warnings = retrieval.warnings;
                    let retrieved = retrieval.chunks;
                    retrieval_traces.extend(retrieved_traces(request.user_message_id, &retrieved));
                    emit(
                        &progress,
                        AgentProgress::RetrievalCompleted {
                            chunk_count: retrieved.len(),
                            warnings: retrieval_warnings.clone(),
                        },
                    );
                    emit(
                        &progress,
                        AgentProgress::StatusUpdated {
                            status: "reranking",
                        },
                    );
                    let reranked = self
                        .reranker
                        .rerank(RerankInput {
                            query: search.rerank_query.clone(),
                            chunks: retrieved,
                            top_k: request.options.retrieval.rerank_top_k.max(1),
                        })
                        .await?;
                    retrieval_traces.extend(reranked_traces(request.user_message_id, &reranked));
                    emit(
                        &progress,
                        AgentProgress::RerankCompleted {
                            top_chunk_ids: reranked
                                .iter()
                                .map(|item| item.chunk.chunk_id)
                                .collect(),
                        },
                    );
                    let accepted = reranked;
                    let accepted_ids = accepted
                        .iter()
                        .map(|item| item.chunk.chunk_id)
                        .collect::<Vec<_>>();
                    let retrieved_ids = retrieval_traces
                        .iter()
                        .rev()
                        .take(request.options.retrieval.rrf_top_k.max(1))
                        .map(|item| item.chunk_id)
                        .collect::<Vec<_>>();
                    merge_evidence(&mut evidence, accepted);
                    let result_summary = format!(
                        "{} top-ranked evidence chunks were supplied for semantic coverage review",
                        accepted_ids.len()
                    );
                    emit(
                        &progress,
                        AgentProgress::ToolCallCompleted {
                            tool_call_id,
                            name: "knowledge_search".to_string(),
                            result: serde_json::json!({
                                "accepted_chunk_count": accepted_ids.len(),
                                "accepted_chunk_ids": accepted_ids,
                                "accumulated_evidence_count": evidence.len(),
                                "warnings": retrieval_warnings,
                            }),
                        },
                    );
                    for query in &search.queries {
                        plan.queries.push(SubQuery {
                            query: query.clone(),
                            reason: decision.decision_summary.clone(),
                        });
                    }
                    plan.mode = if plan.queries.len() > 1 {
                        PlanMode::Multi
                    } else {
                        PlanMode::Single
                    };
                    previous_actions.push(PreviousAction {
                        step,
                        action: action_name.clone(),
                        queries: search.queries.clone(),
                        result_summary,
                    });
                    react_steps.push(ReactStepTrace {
                        step,
                        action: action_name,
                        decision_summary: decision.decision_summary,
                        queries: search.queries,
                        rerank_query: Some(search.rerank_query),
                        hypothetical_answer: search.hypothetical_answer,
                        retrieved_chunk_ids: retrieved_ids,
                        accepted_chunk_ids: accepted_ids,
                        warnings: retrieval_warnings,
                        started_at: step_started,
                        completed_at: now(),
                    });
                }
                ReactActionKind::Finish if !evidence.is_empty() => {
                    let answer_focus = decision
                        .answer_focus
                        .ok_or_else(|| anyhow::anyhow!("finish decision has no answer focus"))?;
                    let selected_evidence =
                        select_evidence(&evidence, &decision.selected_evidence_ids)?;
                    react_steps.push(ReactStepTrace {
                        step,
                        action: action_name,
                        decision_summary: decision.decision_summary,
                        queries: vec![],
                        rerank_query: None,
                        hypothetical_answer: None,
                        retrieved_chunk_ids: vec![],
                        accepted_chunk_ids: selected_evidence
                            .iter()
                            .map(|item| item.chunk.chunk_id)
                            .collect(),
                        warnings: vec![],
                        started_at: step_started,
                        completed_at: now(),
                    });
                    let assembled = self
                        .context_assembler
                        .assemble(ContextInput {
                            chunks: selected_evidence,
                            original_query: request.original_query.clone(),
                            max_context_chars: request.options.runtime.max_context_chars,
                        })
                        .await?;
                    let prompt = self
                        .prompt_registry
                        .compose(
                            prepared.understanding.mode,
                            &request.original_query,
                            &prepared.understanding.standalone_query,
                            &answer_focus,
                            &assembled,
                            &request.options,
                        )
                        .await?;
                    trace.prompt_versions = PromptVersions {
                        persona: prompt.persona_version.clone(),
                        guardrail: prompt.guardrail_version.clone(),
                        mode: prompt.mode_version.clone(),
                        task: prompt.task_version.clone(),
                    };
                    emit(
                        &progress,
                        AgentProgress::StatusUpdated {
                            status: "generating",
                        },
                    );
                    answer_stream = Some(
                        self.answer_generator
                            .generate(
                                prepared.understanding.standalone_query.clone(),
                                assembled,
                                prompt,
                                request.options.generation.clone(),
                                self.claim_verifier.clone(),
                                request.options.require_citation,
                                request.options.runtime.max_repair_attempts,
                            )
                            .await?,
                    );
                    trace.stop_reason = "evidence_sufficient".to_string();
                    break;
                }
                ReactActionKind::Finish => {
                    let result_summary =
                        "finish rejected because no document evidence was observed";
                    previous_actions.push(PreviousAction {
                        step,
                        action: action_name.clone(),
                        queries: vec![],
                        result_summary: result_summary.to_string(),
                    });
                    react_steps.push(ReactStepTrace {
                        step,
                        action: action_name,
                        decision_summary: decision.decision_summary,
                        queries: vec![],
                        rerank_query: None,
                        hypothetical_answer: None,
                        retrieved_chunk_ids: vec![],
                        accepted_chunk_ids: vec![],
                        warnings: vec![result_summary.to_string()],
                        started_at: step_started,
                        completed_at: now(),
                    });
                }
                ReactActionKind::Clarify => {
                    let question = decision.clarification_question.ok_or_else(|| {
                        anyhow::anyhow!("clarify decision has no clarification question")
                    })?;
                    react_steps.push(ReactStepTrace {
                        step,
                        action: action_name,
                        decision_summary: decision.decision_summary,
                        queries: vec![],
                        rerank_query: None,
                        hypothetical_answer: None,
                        retrieved_chunk_ids: vec![],
                        accepted_chunk_ids: vec![],
                        warnings: vec![],
                        started_at: step_started,
                        completed_at: now(),
                    });
                    answer_stream = Some(single_text_stream(question, Confidence::Low));
                    no_answer_reason = Some(NoAnswerReason::NeedsClarification);
                    trace.stop_reason = "clarification_required".to_string();
                    break;
                }
            }
        }

        if answer_stream.is_none() {
            trace.stop_reason = "react_budget_exhausted_without_sufficient_evidence".to_string();
            no_answer_reason = Some(NoAnswerReason::NoRelevantChunks);
            answer_stream = Some(single_text_stream(
                "在本次检索预算内，没有找到足以可靠回答该问题的文档证据。".to_string(),
                Confidence::Low,
            ));
        }
        trace.react_steps = react_steps;
        trace.retrieval_plan = plan.clone();
        let answer_stream = answer_stream
            .ok_or_else(|| anyhow::anyhow!("agent completed without an answer stream"))?;
        Ok(build_run(
            &prepared,
            trace,
            plan,
            retrieval_traces,
            answer_stream,
            no_answer_reason,
        ))
    }
}

fn select_evidence(
    evidence: &[RerankedChunk],
    selected_ids: &[usize],
) -> Result<Vec<RerankedChunk>> {
    let selected = selected_ids
        .iter()
        .filter_map(|id| id.checked_sub(1).and_then(|index| evidence.get(index)))
        .cloned()
        .collect::<Vec<_>>();
    if selected.is_empty() {
        anyhow::bail!("finish action selected no valid document evidence");
    }
    Ok(selected)
}
