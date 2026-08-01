use std::collections::HashSet;
use std::sync::Arc;

use anyhow::{anyhow, Result};

use super::citation_resolver::cited_evidence_indexes;
use super::events::{emit, AgentProgress, ProgressSender};
use super::finalizer::GroundedAnswerFinalizer;
use super::kernel_support::{
    apply_tool_effect, base_trace, bounded_history, build_messages, build_run,
    failed_response_step, failed_tool_step, response_step, single_text_stream,
    successful_tool_step, tool_arguments_value, tool_step_summary, ToolState,
};
use super::model::{
    AgentMessage, AgentModel, AgentModelRequest, AgentModelResponse, AgentModelStreamEvent,
};
use super::prompt::{Prompt, PromptRegistry};
use super::tools::{AgentToolRegistry, ToolExecutionContext};
use crate::models::agent::{AgentMode, AgentRequest, AgentRun, ConversationTurn};
use crate::models::now;
use crate::models::rag::{ContextInput, RerankedChunk};
use crate::models::trace::{RetrievalPlan, RetrievalTrace};
use crate::models::{Confidence, NoAnswerReason, Usage};
use crate::rag::ContextAssembler;

#[derive(Debug, Clone)]
pub struct PreparedAgentRequest {
    pub request: AgentRequest,
    pub bounded_history: Vec<ConversationTurn>,
    pub prompt: Prompt,
    pub mode: AgentMode,
    pub started_at: chrono::DateTime<chrono::Utc>,
}

impl PreparedAgentRequest {
    pub fn standalone_query(&self) -> &str {
        &self.request.original_query
    }

    pub fn context_fingerprint_input(&self) -> Result<String> {
        Ok(serde_json::to_string(&serde_json::json!({
            "history": self.bounded_history,
            "utc_date": now().date_naive(),
        }))?)
    }
}

#[derive(Clone)]
pub struct AgentKernel {
    pub model: Arc<dyn AgentModel>,
    pub tools: AgentToolRegistry,
    pub knowledge_search_component: String,
    pub context_assembler: Arc<dyn ContextAssembler>,
    pub prompt_registry: Arc<dyn PromptRegistry>,
    pub answer_finalizer: Arc<GroundedAnswerFinalizer>,
}

impl AgentKernel {
    pub fn new(
        model: Arc<dyn AgentModel>,
        tools: AgentToolRegistry,
        context_assembler: Arc<dyn ContextAssembler>,
        prompt_registry: Arc<dyn PromptRegistry>,
        answer_finalizer: Arc<GroundedAnswerFinalizer>,
    ) -> Result<Self> {
        let knowledge_search_component = tools
            .component_name("knowledge_search")
            .ok_or_else(|| anyhow!("agent kernel requires the knowledge_search tool"))?;
        Ok(Self {
            model,
            tools,
            knowledge_search_component,
            context_assembler,
            prompt_registry,
            answer_finalizer,
        })
    }

    pub async fn prepare(&self, request: AgentRequest) -> Result<PreparedAgentRequest> {
        let bounded_history = bounded_history(
            &request.history,
            request.options.runtime.max_history_turns,
            request.options.runtime.max_history_chars,
        );
        let prompt = self.prompt_registry.compose(&request.options).await?;
        let mode = request.options.mode.unwrap_or(AgentMode::Answerer);
        Ok(PreparedAgentRequest {
            request,
            bounded_history,
            prompt,
            mode,
            started_at: now(),
        })
    }

    pub async fn run(&self, request: AgentRequest) -> Result<AgentRun> {
        let prepared = self.prepare(request).await?;
        self.run_prepared(prepared, None).await
    }

    pub async fn run_prepared(
        &self,
        prepared: PreparedAgentRequest,
        progress: ProgressSender,
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
                rewritten_query: request.original_query.clone(),
                keywords: Vec::new(),
            },
        );

        let mut trace = base_trace(&prepared, self);
        let mut messages = build_messages(&prepared);
        let definitions = self.tools.definitions();
        let mut evidence = Vec::<RerankedChunk>::new();
        let mut retrieval_traces = Vec::<RetrievalTrace>::new();
        let mut plan = RetrievalPlan::default();
        let mut mode = prepared.mode;
        let mut rewritten_query = request.original_query.clone();
        let mut answer_stream = None;
        let mut no_answer_reason = None;
        let mut usage = Usage {
            input_tokens: 0,
            output_tokens: 0,
        };
        let mut seen_calls = HashSet::new();
        let mut empty_responses = 0usize;
        let mut document_search_attempted = false;
        let mut citation_repair_requested = false;

        for step in 1..=request.options.runtime.max_react_steps.max(1) {
            let (response, response_deltas) = self
                .complete_model(
                    AgentModelRequest {
                        messages: messages.clone(),
                        tools: definitions.clone(),
                        temperature: request.options.generation.temperature,
                        max_tokens: request.options.generation.max_output_tokens,
                    },
                    &progress,
                )
                .await?;
            if let Some(turn_usage) = response.usage.as_ref() {
                usage.input_tokens = usage.input_tokens.saturating_add(turn_usage.input_tokens);
                usage.output_tokens = usage.output_tokens.saturating_add(turn_usage.output_tokens);
            }

            if !response.tool_calls.is_empty() {
                empty_responses = 0;
                let step_output = response
                    .content
                    .as_deref()
                    .map(str::trim)
                    .filter(|content| !content.is_empty())
                    .map(str::to_string);
                emit(
                    &progress,
                    AgentProgress::ReactStepStarted {
                        step,
                        action: "tool".to_string(),
                        decision_summary: tool_step_summary(&response.tool_calls),
                    },
                );
                messages.push(AgentMessage::assistant_with_tools(
                    response.content,
                    response.tool_calls.clone(),
                ));
                let mut terminal = None;
                for call in response.tool_calls {
                    let started_at = now();
                    let arguments = tool_arguments_value(&call.arguments_json);
                    emit(
                        &progress,
                        AgentProgress::ToolCallStarted {
                            tool_call_id: call.id.clone(),
                            name: call.name.clone(),
                            arguments: arguments.clone(),
                        },
                    );
                    let fingerprint = format!("{}:{}", call.name, call.arguments_json);
                    if !seen_calls.insert(fingerprint) {
                        let error = serde_json::json!({
                            "error_type": "duplicate_tool_call",
                            "retryable": false,
                            "message": "The identical tool call already ran. Change the query or answer from existing observations."
                        });
                        emit_tool_failure(&progress, &call.id, &call.name, error.clone());
                        messages.push(AgentMessage::tool(call.id.clone(), error.to_string()));
                        trace.react_steps.push(failed_tool_step(
                            step,
                            &call,
                            arguments,
                            error,
                            step_output.as_deref(),
                            "identical tool call rejected",
                            started_at,
                        ));
                        continue;
                    }

                    let context = ToolExecutionContext {
                        request,
                        progress: &progress,
                    };
                    match self.tools.execute(&call, &context).await {
                        Ok(execution) => {
                            let previous_query = rewritten_query.clone();
                            let applied = apply_tool_effect(
                                execution.effect,
                                execution.model_result,
                                execution.public_result,
                                ToolState {
                                    evidence: &mut evidence,
                                    retrieval_traces: &mut retrieval_traces,
                                    plan: &mut plan,
                                    keywords: &mut trace.keywords,
                                    resolved_refs: &mut trace.resolved_refs,
                                    mode: &mut mode,
                                    rewritten_query: &mut rewritten_query,
                                    max_context_chars: request.options.runtime.max_context_chars,
                                },
                            );
                            document_search_attempted |= applied.document_search_attempted;
                            if rewritten_query != previous_query {
                                emit(
                                    &progress,
                                    AgentProgress::RewriteCompleted {
                                        rewritten_query: rewritten_query.clone(),
                                        keywords: Vec::new(),
                                    },
                                );
                            }
                            let public_result = applied.public_result.clone();
                            emit(
                                &progress,
                                AgentProgress::ToolCallCompleted {
                                    tool_call_id: call.id.clone(),
                                    name: call.name.clone(),
                                    result: public_result.clone(),
                                },
                            );
                            messages.push(AgentMessage::tool(
                                call.id.clone(),
                                applied.model_result.to_string(),
                            ));
                            trace.react_steps.push(successful_tool_step(
                                step,
                                &call,
                                arguments,
                                public_result,
                                step_output.as_deref(),
                                &applied.trace,
                                started_at,
                            ));
                            if let Some(effect) = applied.terminal {
                                terminal = Some(effect);
                            }
                        }
                        Err(error) => {
                            let payload = serde_json::json!({
                                "error_type": "tool_execution_error",
                                "retryable": false,
                                "message": error.to_string()
                            });
                            emit_tool_failure(&progress, &call.id, &call.name, payload.clone());
                            messages.push(AgentMessage::tool(call.id.clone(), payload.to_string()));
                            trace.react_steps.push(failed_tool_step(
                                step,
                                &call,
                                arguments,
                                payload,
                                step_output.as_deref(),
                                &error.to_string(),
                                started_at,
                            ));
                        }
                    }
                }
                if let Some(effect) = terminal {
                    mode = effect.mode;
                    no_answer_reason = effect.no_answer_reason;
                    answer_stream = Some(single_text_stream(
                        effect.answer,
                        effect.confidence,
                        Some(usage.clone()),
                    ));
                    trace.stop_reason = "waiting_for_clarification".to_string();
                    break;
                }
                continue;
            }

            if response.has_content() {
                let content = response
                    .content
                    .ok_or_else(|| anyhow!("agent response content disappeared"))?;
                let citation_indexes = cited_evidence_indexes(&content);
                if evidence.is_empty() && !citation_indexes.is_empty() {
                    messages.push(AgentMessage::assistant(content.clone()));
                    messages.push(AgentMessage::user(
                        "Runtime grounding guard: citation markers are invalid because this turn has no document evidence. Call knowledge_search to obtain current evidence, or answer without document claims and citations.",
                    ));
                    trace.react_steps.push(failed_response_step(
                        step,
                        &content,
                        "citation markers rejected because this turn has no document evidence",
                    ));
                    continue;
                }
                let citations_invalid = citation_indexes.is_empty()
                    || citation_indexes
                        .iter()
                        .any(|index| *index == 0 || *index as usize > evidence.len());
                if !evidence.is_empty()
                    && request.options.require_citation
                    && citations_invalid
                    && !citation_repair_requested
                    && step < request.options.runtime.max_react_steps.max(1)
                {
                    citation_repair_requested = true;
                    messages.push(AgentMessage::assistant(content.clone()));
                    messages.push(AgentMessage::user(
                        "Runtime grounding guard: the answer is useful but its citations are missing or invalid. Keep the conclusion and explanation, then revise it once with valid evidence ids immediately after the claims they support.",
                    ));
                    trace.react_steps.push(failed_response_step(
                        step,
                        &content,
                        "grounded answer requested one citation repair",
                    ));
                    continue;
                }
                emit(
                    &progress,
                    AgentProgress::ReactStepStarted {
                        step,
                        action: "respond".to_string(),
                        decision_summary: if evidence.is_empty() {
                            "direct response without tools".to_string()
                        } else {
                            "grounded response from accumulated evidence".to_string()
                        },
                    },
                );
                for delta in response_deltas {
                    emit(&progress, AgentProgress::ResponseDelta { delta });
                }
                emit(&progress, AgentProgress::ReactStepCompleted { step });
                trace.react_steps.push(response_step(step, &content));
                if evidence.is_empty() {
                    let confidence = if document_search_attempted {
                        no_answer_reason = Some(NoAnswerReason::NoRelevantChunks);
                        Confidence::Low
                    } else {
                        Confidence::Medium
                    };
                    answer_stream =
                        Some(single_text_stream(content, confidence, Some(usage.clone())));
                    trace.stop_reason = if document_search_attempted {
                        "no_relevant_evidence_response".to_string()
                    } else {
                        "direct_response".to_string()
                    };
                } else {
                    emit(
                        &progress,
                        AgentProgress::StatusUpdated {
                            status: "verifying",
                        },
                    );
                    let assembled = self
                        .context_assembler
                        .assemble(ContextInput {
                            chunks: evidence.clone(),
                            original_query: request.original_query.clone(),
                            max_context_chars: request.options.runtime.max_context_chars,
                        })
                        .await?;
                    answer_stream = Some(
                        self.answer_finalizer
                            .finalize(
                                &rewritten_query,
                                content,
                                assembled,
                                request.options.require_citation,
                                request.options.runtime.allow_verifier_correction,
                                Some(usage.clone()),
                            )
                            .await?,
                    );
                    trace.stop_reason = "grounded_response".to_string();
                }
                break;
            }

            empty_responses += 1;
            if empty_responses > 1 {
                return Err(anyhow!(
                    "agent model returned neither content nor tool calls twice"
                ));
            }
            messages.push(AgentMessage::user(
                "Your previous turn was empty. Reply now, or call one available tool.",
            ));
        }

        if answer_stream.is_none() {
            trace.stop_reason = "react_budget_exhausted".to_string();
            no_answer_reason = Some(NoAnswerReason::NoRelevantChunks);
            answer_stream = Some(single_text_stream(
                "已达到本次处理步骤上限，暂时无法可靠完成这个问题。".to_string(),
                Confidence::Low,
                Some(usage.clone()),
            ));
        }
        trace.mode = mode;
        trace.rewritten_query = Some(rewritten_query.clone());
        trace.retrieval_plan = plan.clone();
        trace.usage = Some(usage);
        let answer_stream =
            answer_stream.ok_or_else(|| anyhow!("agent completed without an answer stream"))?;
        Ok(build_run(
            &prepared,
            mode,
            rewritten_query,
            trace,
            plan,
            retrieval_traces,
            answer_stream,
            no_answer_reason,
        ))
    }

    async fn complete_model(
        &self,
        request: AgentModelRequest,
        progress: &ProgressSender,
    ) -> Result<(AgentModelResponse, Vec<String>)> {
        let Some(progress_sender) = progress.as_ref() else {
            return Ok((self.model.complete(request).await?, Vec::new()));
        };
        let (stream_sender, mut stream_receiver) = tokio::sync::mpsc::unbounded_channel();
        let relay_sender = progress_sender.clone();
        let relay = tokio::spawn(async move {
            let mut response_deltas = Vec::new();
            while let Some(event) = stream_receiver.recv().await {
                match event {
                    AgentModelStreamEvent::ResponseDelta(delta) => response_deltas.push(delta),
                    AgentModelStreamEvent::ThinkingDelta(delta) => {
                        if relay_sender
                            .send(AgentProgress::ThinkingDelta { delta })
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
            response_deltas
        });
        let response = self
            .model
            .complete_streamed(request, Some(stream_sender))
            .await;
        let response_deltas = relay
            .await
            .map_err(|error| anyhow!("model stream relay failed: {error}"))?;

        let (acknowledgement, flushed) = tokio::sync::oneshot::channel();
        if progress_sender
            .send(AgentProgress::Flush { acknowledgement })
            .is_ok()
        {
            flushed
                .await
                .map_err(|_| anyhow!("model stream flush acknowledgement was dropped"))?;
        }
        Ok((response?, response_deltas))
    }
}

fn emit_tool_failure(
    progress: &ProgressSender,
    tool_call_id: &str,
    name: &str,
    error: serde_json::Value,
) {
    emit(
        progress,
        AgentProgress::ToolCallFailed {
            tool_call_id: tool_call_id.to_string(),
            name: name.to_string(),
            error,
        },
    );
}
