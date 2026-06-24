use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::response::sse::{Event, Sse};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc::unbounded_channel;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tracing::error;
use uuid::Uuid;

use crate::agent::{AgentKernel, AgentProgress};
use crate::auth::ActorExtractor;
use crate::error::AppError;
use crate::models::agent::{
    AgentOptions, AgentRequest, AnswerStreamItem, CitationOutput, ConversationTurn,
    RetrievalRuntimeConfig,
};
use crate::models::citation::Citation;
use crate::models::conversation::{
    ConversationListResponse, ConversationSession, CreateConversationRequest,
};
use crate::models::feedback::{Feedback, FeedbackResponse, SubmitFeedbackRequest};
use crate::models::message::{
    ConversationMessage, MessageListResponse, MessageResponse, RetryMessageRequest,
    SendMessageRequest,
};
use crate::models::trace::{QueryTrace, RetrievalSource, RetrievalTrace};
use crate::models::{now, ActorScope, Confidence, MessageRole, MessageStatus, NoAnswerReason};
use crate::repositories::cache_key;
use crate::repositories::{AnswerCache, CachedAnswer, ConversationRepository};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct ListConversationsQuery {
    #[serde(default = "default_limit")]
    limit: usize,
    #[serde(default)]
    cursor: Option<String>,
}

fn default_limit() -> usize {
    20
}

pub fn router() -> axum::Router<AppState> {
    axum::Router::new()
        .route(
            "/api/conversations",
            axum::routing::post(create_conversation).get(list_conversations),
        )
        .route(
            "/api/conversations/:conversation_id",
            axum::routing::get(get_conversation).delete(delete_conversation),
        )
        .route(
            "/api/conversations/:conversation_id/messages",
            axum::routing::get(get_messages).post(send_message),
        )
        .route(
            "/api/conversations/:conversation_id/messages/:message_id/traces",
            axum::routing::get(get_message_traces),
        )
        .route(
            "/api/conversations/:conversation_id/messages/:message_id/cancel",
            axum::routing::post(cancel_message),
        )
        .route(
            "/api/conversations/:conversation_id/messages/:message_id/retry",
            axum::routing::post(retry_message),
        )
        .route(
            "/api/conversations/:conversation_id/messages/:message_id/feedback",
            axum::routing::post(submit_feedback),
        )
}

async fn create_conversation(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Json(req): Json<CreateConversationRequest>,
) -> Result<impl IntoResponse, AppError> {
    let effective_kb_ids = intersect_kb_ids(&req.kb_ids, &actor.allowed_kb_ids);
    if !req.kb_ids.is_empty() && effective_kb_ids.is_empty() {
        return Err(AppError::kb_scope_denied());
    }
    let kb_ids = if effective_kb_ids.is_empty() {
        actor.allowed_kb_ids.clone()
    } else {
        effective_kb_ids
    };

    let title = req.title.clone().unwrap_or_else(|| "新会话".to_string());
    let session = ConversationSession {
        id: Uuid::new_v4(),
        tenant_id: actor.tenant_id,
        user_id: actor.user_id,
        title,
        kb_ids,
        status: crate::models::ConversationStatus::Active,
        summary: None,
        created_at: now(),
        updated_at: now(),
    };
    state.repository.create_session(session.clone()).await?;
    Ok(Json(json!({
        "conversation_id": session.id,
        "title": session.title,
        "kb_ids": session.kb_ids,
        "created_at": session.created_at
    })))
}

async fn list_conversations(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Query(query): Query<ListConversationsQuery>,
) -> Result<Json<ConversationListResponse>, AppError> {
    let resp = state
        .repository
        .list_sessions(actor.tenant_id, actor.user_id, query.limit, query.cursor)
        .await?;
    Ok(Json(resp))
}

async fn get_messages(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(conversation_id): Path<Uuid>,
) -> Result<Json<MessageListResponse>, AppError> {
    let session = state
        .repository
        .get_session(actor.tenant_id, conversation_id)
        .await?
        .ok_or_else(AppError::conversation_not_found)?;
    let messages = state
        .repository
        .get_messages(actor.tenant_id, session.id)
        .await?;
    let mut responses = Vec::with_capacity(messages.len());
    for m in &messages {
        responses.push(message_to_response(&state.repository, m).await?);
    }
    Ok(Json(MessageListResponse {
        conversation_id: session.id,
        messages: responses,
    }))
}

async fn message_to_response(
    repo: &Arc<dyn ConversationRepository>,
    message: &ConversationMessage,
) -> Result<MessageResponse, AppError> {
    let citations = if message.role == MessageRole::Assistant {
        repo.get_citations(message.id).await?
    } else {
        vec![]
    };
    let citation_resps: Vec<_> = citations.iter().map(|c| c.into()).collect();
    Ok(MessageResponse {
        message_id: message.id,
        role: message.role.to_string(),
        content: message.content.clone(),
        status: message.status.to_string(),
        confidence: message.confidence.as_ref().map(|c| c.to_string()),
        no_answer_reason: message.no_answer_reason.as_ref().map(|r| r.to_string()),
        agent_mode: message.agent_mode.as_ref().map(|m| m.to_string()),
        prompt_versions: message.prompt_versions.clone(),
        citations: citation_resps,
        parent_message_id: message.parent_message_id,
        retry_of_message_id: message.retry_of_message_id,
        created_at: message.created_at,
        completed_at: message.completed_at,
    })
}

#[derive(Debug, Clone)]
enum SseEvent {
    MessageCreated {
        user_message_id: Uuid,
        assistant_message_id: Uuid,
    },
    StatusUpdated {
        message_id: Uuid,
        status: &'static str,
    },
    RewriteCompleted {
        message_id: Uuid,
        rewritten_query: String,
        keywords: Vec<String>,
    },
    RetrievalCompleted {
        message_id: Uuid,
        chunk_count: usize,
    },
    RerankCompleted {
        message_id: Uuid,
        top_chunk_ids: Vec<Uuid>,
    },
    AnswerDelta {
        message_id: Uuid,
        text: String,
    },
    CitationDelta {
        message_id: Uuid,
        citation: CitationOutput,
    },
    AnswerCompleted {
        message_id: Uuid,
        confidence: Confidence,
        usage: Option<crate::models::Usage>,
    },
    AnswerFailed {
        message_id: Uuid,
        code: String,
        message: String,
    },
}

impl SseEvent {
    fn event_name(&self) -> &'static str {
        match self {
            SseEvent::MessageCreated { .. } => "message.created",
            SseEvent::StatusUpdated { .. } => "status.updated",
            SseEvent::RewriteCompleted { .. } => "rewrite.completed",
            SseEvent::RetrievalCompleted { .. } => "retrieval.completed",
            SseEvent::RerankCompleted { .. } => "rerank.completed",
            SseEvent::AnswerDelta { .. } => "answer.delta",
            SseEvent::CitationDelta { .. } => "citation.delta",
            SseEvent::AnswerCompleted { .. } => "answer.completed",
            SseEvent::AnswerFailed { .. } => "answer.failed",
        }
    }

    fn data_json(&self) -> serde_json::Value {
        match self {
            SseEvent::MessageCreated {
                user_message_id,
                assistant_message_id,
            } => json!({
                "user_message_id": user_message_id,
                "assistant_message_id": assistant_message_id,
            }),
            SseEvent::StatusUpdated { message_id, status } => json!({
                "message_id": message_id,
                "status": status,
            }),
            SseEvent::RewriteCompleted {
                message_id,
                rewritten_query,
                keywords,
            } => json!({
                "message_id": message_id,
                "rewritten_query": rewritten_query,
                "keywords": keywords,
            }),
            SseEvent::RetrievalCompleted {
                message_id,
                chunk_count,
            } => json!({
                "message_id": message_id,
                "chunk_count": chunk_count,
            }),
            SseEvent::RerankCompleted {
                message_id,
                top_chunk_ids,
            } => json!({
                "message_id": message_id,
                "top_chunk_ids": top_chunk_ids,
            }),
            SseEvent::AnswerDelta { message_id, text } => json!({
                "message_id": message_id,
                "text": text,
            }),
            SseEvent::CitationDelta {
                message_id,
                citation,
            } => json!({
                "message_id": message_id,
                "citation": citation,
            }),
            SseEvent::AnswerCompleted {
                message_id,
                confidence,
                usage,
            } => json!({
                "message_id": message_id,
                "confidence": confidence.to_string(),
                "usage": usage,
            }),
            SseEvent::AnswerFailed {
                message_id,
                code,
                message,
            } => json!({
                "message_id": message_id,
                "code": code,
                "message": message,
            }),
        }
    }

    fn to_sse_event(&self) -> Event {
        Event::default()
            .event(self.event_name())
            .data(self.data_json().to_string())
    }
}

async fn send_message(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(conversation_id): Path<Uuid>,
    Json(req): Json<SendMessageRequest>,
) -> Result<Sse<UnboundedReceiverStream<Result<Event, Infallible>>>, AppError> {
    let content = req.content.trim().to_string();
    if content.is_empty() {
        return Err(AppError::bad_request("EMPTY_MESSAGE", "消息内容不能为空"));
    }

    let (session, effective_kb_ids) =
        resolve_conversation_scope(&state, &actor, conversation_id, &req.kb_ids).await?;

    if let Some(ref client_request_id) = req.client_request_id {
        if let Some(existing) = state
            .repository
            .find_message_by_client_request_id(actor.tenant_id, actor.user_id, client_request_id)
            .await?
        {
            if existing.conversation_id == conversation_id {
                return Err(AppError::client_request_conflict());
            }
        }
    }

    let user_message = ConversationMessage {
        id: Uuid::new_v4(),
        conversation_id: session.id,
        tenant_id: actor.tenant_id,
        user_id: actor.user_id,
        role: MessageRole::User,
        content: content.clone(),
        status: MessageStatus::Completed,
        parent_message_id: None,
        retry_of_message_id: None,
        client_request_id: req.client_request_id.clone(),
        confidence: None,
        no_answer_reason: None,
        error_code: None,
        error_message: None,
        agent_mode: None,
        prompt_versions: None,
        created_at: now(),
        completed_at: Some(now()),
    };
    state
        .repository
        .create_message(user_message.clone())
        .await?;

    let assistant_message_id = Uuid::new_v4();
    let assistant_message = ConversationMessage {
        id: assistant_message_id,
        conversation_id: session.id,
        tenant_id: actor.tenant_id,
        user_id: actor.user_id,
        role: MessageRole::Assistant,
        content: String::new(),
        status: MessageStatus::Answering,
        parent_message_id: Some(user_message.id),
        retry_of_message_id: None,
        client_request_id: None,
        confidence: None,
        no_answer_reason: None,
        error_code: None,
        error_message: None,
        agent_mode: None,
        prompt_versions: None,
        created_at: now(),
        completed_at: None,
    };
    state
        .repository
        .create_message(assistant_message.clone())
        .await?;

    let (tx, rx) = unbounded_channel::<Result<Event, Infallible>>();
    let tx2 = tx.clone();
    let repo = state.repository.clone();
    let cache = state.cache.clone();
    let kernel = state.agent_kernel;
    let config = state.config.clone();

    let _ = tx2.send(Ok(SseEvent::MessageCreated {
        user_message_id: user_message.id,
        assistant_message_id,
    }
    .to_sse_event()));

    tokio::spawn(async move {
        if let Err(e) = run_agent_pipeline(
            repo,
            cache,
            kernel,
            config,
            actor,
            session.id,
            user_message.id,
            assistant_message_id,
            content,
            effective_kb_ids,
            tx2,
        )
        .await
        {
            error!("agent pipeline failed: {e:?}");
        }
    });

    Ok(Sse::new(UnboundedReceiverStream::new(rx)))
}

#[allow(clippy::too_many_arguments)]
async fn run_agent_pipeline(
    repo: Arc<dyn ConversationRepository>,
    cache: Arc<dyn AnswerCache>,
    kernel: AgentKernel,
    config: crate::config::AppConfig,
    actor: ActorScope,
    conversation_id: Uuid,
    user_message_id: Uuid,
    assistant_message_id: Uuid,
    original_query: String,
    effective_kb_ids: Vec<Uuid>,
    tx: tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>,
) -> Result<(), AppError> {
    // Build history from previous completed QA pairs.
    let history = build_history(&repo, actor.tenant_id, conversation_id, user_message_id).await?;
    let doc_version_hash = repo
        .doc_version_hash(actor.tenant_id, &effective_kb_ids)
        .await?;

    let cache_key = cache_key(
        "v1",
        actor.tenant_id,
        &effective_kb_ids,
        &original_query,
        &doc_version_hash,
    );
    let answer_cache_enabled = !config.rag.generation.use_real_llm && should_cache(&original_query);
    let cached_answer = if answer_cache_enabled {
        cache.get(&cache_key).await?
    } else {
        None
    };

    let mut stream: tokio::sync::mpsc::UnboundedReceiver<AnswerStreamItem>;
    let mut trace;
    let mode;
    let rewritten_query;
    let mut agent_no_answer_reason: Option<NoAnswerReason> = None;
    let mut pipeline_retrieval_traces: Vec<RetrievalTrace> = vec![];

    if let Some(cached) = cached_answer {
        mode = crate::models::agent::AgentMode::Answerer;
        rewritten_query = Some(original_query.clone());
        trace = crate::models::agent::AgentTrace {
            mode_reason: "cache hit".to_string(),
            rewritten_query: rewritten_query.clone(),
            keywords: vec![original_query.clone()],
            resolved_refs: vec![],
            retrieval_plan: crate::models::trace::RetrievalPlan::default(),
            prompt_versions: crate::models::agent::PromptVersions {
                persona: "persona-v1".to_string(),
                guardrail: "grounded-guardrail-v1".to_string(),
                mode: "mode-answerer-v1".to_string(),
                task: "grounded-task-v1".to_string(),
            },
            model: config.rag.generation.model.clone(),
            usage: None,
            started_at: now(),
        };
        let (tx2, rx2) = unbounded_channel();
        tokio::spawn(async move {
            let _ = tx2.send(AnswerStreamItem::Delta {
                text: cached.answer.clone(),
            });
            for c in cached.citations {
                let _ = tx2.send(AnswerStreamItem::Citation { citation: c });
            }
            let _ = tx2.send(AnswerStreamItem::Completed {
                confidence: cached.confidence,
                usage: Some(crate::models::Usage {
                    input_tokens: 0,
                    output_tokens: cached.answer.len() as u32,
                }),
            });
        });
        stream = rx2;
    } else {
        let (progress_tx, mut progress_rx) = unbounded_channel::<AgentProgress>();
        let progress_sse_tx = tx.clone();
        tokio::spawn(async move {
            while let Some(progress) = progress_rx.recv().await {
                let event = progress_to_sse_event(assistant_message_id, progress);
                let _ = progress_sse_tx.send(Ok(event.to_sse_event()));
            }
        });

        let agent_req = AgentRequest {
            tenant_id: actor.tenant_id,
            user_id: actor.user_id,
            conversation_id,
            user_message_id,
            assistant_message_id,
            original_query: original_query.clone(),
            effective_kb_ids: effective_kb_ids.clone(),
            history: history.clone(),
            options: agent_options_from_config(&config),
        };
        let run = match kernel.run_with_progress(agent_req, Some(progress_tx)).await {
            Ok(run) => run,
            Err(err) => {
                let message = err.to_string();
                fail_assistant_message(
                    &repo,
                    actor.tenant_id,
                    assistant_message_id,
                    "PIPELINE_ERROR".to_string(),
                    message.clone(),
                    &tx,
                )
                .await?;
                return Ok(());
            }
        };
        mode = run.mode;
        rewritten_query = run.rewritten_query.clone();
        trace = run.trace;
        agent_no_answer_reason = run.no_answer_reason;
        pipeline_retrieval_traces = run.retrieval_traces;
        stream = run.answer_stream;
    }

    let mut answer_text = String::new();
    let mut citations: Vec<CitationOutput> = vec![];
    let mut confidence = Confidence::Low;
    let mut usage: Option<crate::models::Usage> = None;
    let mut failed: Option<(String, String)> = None;

    while let Some(item) = stream.recv().await {
        if assistant_message_cancelled(&repo, actor.tenant_id, assistant_message_id).await? {
            return Ok(());
        }
        match item {
            AnswerStreamItem::Delta { text } => {
                answer_text.push_str(&text);
                let _ = tx.send(Ok(SseEvent::AnswerDelta {
                    message_id: assistant_message_id,
                    text,
                }
                .to_sse_event()));
            }
            AnswerStreamItem::Citation { citation } => {
                citations.push(citation.clone());
                let _ = tx.send(Ok(SseEvent::CitationDelta {
                    message_id: assistant_message_id,
                    citation,
                }
                .to_sse_event()));
            }
            AnswerStreamItem::Completed {
                confidence: c,
                usage: u,
            } => {
                confidence = c;
                usage = u;
            }
            AnswerStreamItem::Failed { code, message } => {
                failed = Some((code, message));
            }
        }
    }

    let no_answer_reason = if confidence == Confidence::Low && citations.is_empty() {
        agent_no_answer_reason.or(Some(NoAnswerReason::NoRelevantChunks))
    } else {
        agent_no_answer_reason
    };

    if let Some((code, message)) = failed {
        let _ = tx.send(Ok(SseEvent::AnswerFailed {
            message_id: assistant_message_id,
            code: code.clone(),
            message: message.clone(),
        }
        .to_sse_event()));
        let mut msg = repo
            .get_message(actor.tenant_id, assistant_message_id)
            .await?
            .ok_or_else(AppError::message_not_found)?;
        msg.status = MessageStatus::Failed;
        msg.error_code = Some(code);
        msg.error_message = Some(message);
        msg.completed_at = Some(now());
        repo.update_message(msg).await?;
        return Ok(());
    }

    // Persist assistant message
    if assistant_message_cancelled(&repo, actor.tenant_id, assistant_message_id).await? {
        return Ok(());
    }
    let mut msg = repo
        .get_message(actor.tenant_id, assistant_message_id)
        .await?
        .ok_or_else(AppError::message_not_found)?;
    msg.content = answer_text.clone();
    msg.status = MessageStatus::Completed;
    msg.confidence = Some(confidence);
    msg.no_answer_reason = no_answer_reason;
    msg.agent_mode = Some(mode);
    msg.prompt_versions = Some(trace.prompt_versions.clone());
    msg.completed_at = Some(now());
    repo.update_message(msg).await?;

    // Save query trace
    let query_trace = QueryTrace {
        id: Uuid::new_v4(),
        message_id: user_message_id,
        original_query: original_query.clone(),
        rewritten_query: rewritten_query.clone(),
        keywords: trace.keywords.clone(),
        hypothetical_answer: None,
        resolved_refs: trace.resolved_refs.clone(),
        effective_kb_ids: effective_kb_ids.clone(),
        rewrite_model: config.rag.rewrite.model.clone(),
        created_at: now(),
    };
    repo.save_query_trace(query_trace).await?;

    // Update trace usage before persisting the agent trace.
    if let Some(u) = usage.clone() {
        trace.usage = Some(u);
    }

    // Save agent trace
    repo.save_agent_trace(assistant_message_id, trace.clone())
        .await?;

    // Save citations
    let citation_models: Vec<Citation> = citations
        .iter()
        .enumerate()
        .map(|(i, c)| Citation {
            id: Uuid::new_v4(),
            assistant_message_id,
            index: i as i32 + 1,
            chunk_id: c.chunk_id,
            doc_id: c.doc_id,
            doc_title: c.doc_title.clone(),
            page_range: c.page_range.clone(),
            heading_path: vec![],
            quote: c.quote.clone(),
            score: c.score,
            source_status: c.source_status.clone(),
        })
        .collect();
    repo.save_citations(citation_models.clone()).await?;

    // Save retrieval traces from the pipeline. Cached answers fall back to citation evidence.
    let retrieval_traces = if pipeline_retrieval_traces.is_empty() {
        citation_retrieval_traces(user_message_id, &citations)
    } else {
        pipeline_retrieval_traces
    };
    repo.save_retrieval_traces(retrieval_traces).await?;

    // Update session updated_at
    if let Some(mut session) = repo.get_session(actor.tenant_id, conversation_id).await? {
        session.updated_at = now();
        repo.update_session(session).await?;
    }

    // Cache answer if high confidence and has citations
    if confidence == Confidence::High && !citations.is_empty() && answer_cache_enabled {
        let cached = CachedAnswer {
            answer: answer_text,
            citations: citations.clone(),
            confidence,
            created_at: now(),
            expires_at: now() + chrono::Duration::hours(24),
        };
        cache.set(&cache_key, cached).await?;
    }

    let _ = tx.send(Ok(SseEvent::AnswerCompleted {
        message_id: assistant_message_id,
        confidence,
        usage: usage.clone(),
    }
    .to_sse_event()));

    // Trace is kept in memory only for stub; could be persisted here.
    let _ = (mode, trace);

    Ok(())
}

fn progress_to_sse_event(message_id: Uuid, progress: AgentProgress) -> SseEvent {
    match progress {
        AgentProgress::StatusUpdated { status } => SseEvent::StatusUpdated { message_id, status },
        AgentProgress::RewriteCompleted {
            rewritten_query,
            keywords,
        } => SseEvent::RewriteCompleted {
            message_id,
            rewritten_query,
            keywords,
        },
        AgentProgress::RetrievalCompleted { chunk_count } => SseEvent::RetrievalCompleted {
            message_id,
            chunk_count,
        },
        AgentProgress::RerankCompleted { top_chunk_ids } => SseEvent::RerankCompleted {
            message_id,
            top_chunk_ids,
        },
    }
}

async fn assistant_message_cancelled(
    repo: &Arc<dyn ConversationRepository>,
    tenant_id: Uuid,
    assistant_message_id: Uuid,
) -> Result<bool, AppError> {
    let Some(message) = repo.get_message(tenant_id, assistant_message_id).await? else {
        return Ok(false);
    };
    Ok(message.status == MessageStatus::Cancelled)
}

async fn fail_assistant_message(
    repo: &Arc<dyn ConversationRepository>,
    tenant_id: Uuid,
    assistant_message_id: Uuid,
    code: String,
    message: String,
    tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>,
) -> Result<(), AppError> {
    let _ = tx.send(Ok(SseEvent::AnswerFailed {
        message_id: assistant_message_id,
        code: code.clone(),
        message: message.clone(),
    }
    .to_sse_event()));
    let mut msg = repo
        .get_message(tenant_id, assistant_message_id)
        .await?
        .ok_or_else(AppError::message_not_found)?;
    msg.status = MessageStatus::Failed;
    msg.error_code = Some(code);
    msg.error_message = Some(message);
    msg.completed_at = Some(now());
    repo.update_message(msg).await?;
    Ok(())
}

fn should_cache(query: &str) -> bool {
    let forbidden = ["最新", "今天", "刚刚", "现在"];
    !forbidden.iter().any(|w| query.contains(w))
}

fn agent_options_from_config(config: &crate::config::AppConfig) -> AgentOptions {
    AgentOptions {
        mode: None,
        tone: config.agent.default_tone.clone(),
        proactive_followup: config.agent.proactive_followup,
        max_followup_suggestions: config.agent.max_followup_suggestions,
        allow_analyst_mode: config.agent.allow_analyst_mode,
        require_citation: config.rag.citation.require_citation,
        generation: crate::models::agent::GenerationConfig {
            model: config.rag.generation.model.clone(),
            temperature: config.rag.generation.temperature,
            max_output_tokens: config.rag.generation.max_output_tokens,
        },
        retrieval: RetrievalRuntimeConfig {
            dense_top_k: config.rag.retrieval.dense_top_k,
            bm25_top_k: config.rag.retrieval.bm25_top_k,
            rrf_top_k: config.rag.retrieval.rrf_top_k,
            rerank_top_k: config.rag.retrieval.effective_top_k,
            rerank_enabled: config.rag.rerank.enabled,
            rerank_min_score: config.rag.rerank.min_score,
        },
    }
}

fn citation_retrieval_traces(
    user_message_id: Uuid,
    citations: &[CitationOutput],
) -> Vec<RetrievalTrace> {
    citations
        .iter()
        .enumerate()
        .map(|(i, c)| RetrievalTrace {
            id: Uuid::new_v4(),
            message_id: user_message_id,
            chunk_id: c.chunk_id,
            doc_id: c.doc_id,
            source: RetrievalSource::Rerank,
            rank: i as i32 + 1,
            score: c.score,
            heading_path: vec![],
            page_range: c.page_range.clone(),
            content_preview: c.quote.clone(),
        })
        .collect()
}

async fn build_history(
    repo: &Arc<dyn ConversationRepository>,
    tenant_id: Uuid,
    conversation_id: Uuid,
    exclude_user_message_id: Uuid,
) -> Result<Vec<ConversationTurn>, AppError> {
    let messages = repo.get_messages(tenant_id, conversation_id).await?;
    let mut turns: Vec<ConversationTurn> = vec![];
    let mut user_map: std::collections::HashMap<Uuid, ConversationMessage> =
        std::collections::HashMap::new();
    let mut assistant_map: std::collections::HashMap<Uuid, ConversationMessage> =
        std::collections::HashMap::new();

    for m in &messages {
        if m.id == exclude_user_message_id {
            continue;
        }
        match m.role {
            MessageRole::User => {
                user_map.insert(m.id, m.clone());
            }
            MessageRole::Assistant => {
                assistant_map.insert(m.id, m.clone());
            }
        }
    }

    let mut assistant_msgs: Vec<&ConversationMessage> = assistant_map.values().collect();
    assistant_msgs.sort_by_key(|m| m.created_at);
    assistant_msgs.reverse();

    for a in assistant_msgs.into_iter().take(5) {
        if let Some(parent_id) = a.parent_message_id {
            if let Some(u) = user_map.get(&parent_id) {
                if a.status == MessageStatus::Completed && !a.content.is_empty() {
                    turns.push(ConversationTurn {
                        user_message: u.content.clone(),
                        assistant_answer: a.content.clone(),
                        citations: vec![],
                    });
                }
            }
        }
    }
    turns.reverse();
    Ok(turns)
}

async fn resolve_conversation_scope(
    state: &AppState,
    actor: &ActorScope,
    conversation_id: Uuid,
    requested_kb_ids: &[Uuid],
) -> Result<(ConversationSession, Vec<Uuid>), AppError> {
    let session = state
        .repository
        .get_session(actor.tenant_id, conversation_id)
        .await?
        .ok_or_else(AppError::conversation_not_found)?;

    let base: Vec<Uuid> = if requested_kb_ids.is_empty() {
        session.kb_ids.clone()
    } else {
        requested_kb_ids.to_vec()
    };

    let effective = intersect_kb_ids(&base, &actor.allowed_kb_ids);
    if !base.is_empty() && effective.is_empty() {
        return Err(AppError::kb_scope_denied());
    }

    let effective = if effective.is_empty() {
        session.kb_ids.clone()
    } else {
        effective
    };

    Ok((session, effective))
}

fn intersect_kb_ids(a: &[Uuid], b: &[Uuid]) -> Vec<Uuid> {
    a.iter().filter(|id| b.contains(id)).copied().collect()
}

async fn cancel_message(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path((conversation_id, message_id)): Path<(Uuid, Uuid)>,
) -> Result<impl IntoResponse, AppError> {
    let _session = state
        .repository
        .get_session(actor.tenant_id, conversation_id)
        .await?
        .ok_or_else(AppError::conversation_not_found)?;
    let mut message = state
        .repository
        .get_message(actor.tenant_id, message_id)
        .await?
        .ok_or_else(AppError::message_not_found)?;
    if message.conversation_id != conversation_id {
        return Err(AppError::message_not_found());
    }
    if message.status != MessageStatus::Answering {
        return Err(AppError::invalid_message_state());
    }
    message.status = MessageStatus::Cancelled;
    message.completed_at = Some(now());
    state.repository.update_message(message.clone()).await?;
    Ok(Json(json!({
        "message_id": message.id,
        "status": message.status.to_string()
    })))
}

async fn retry_message(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path((conversation_id, message_id)): Path<(Uuid, Uuid)>,
    Json(_req): Json<RetryMessageRequest>,
) -> Result<Sse<UnboundedReceiverStream<Result<Event, Infallible>>>, AppError> {
    let (session, effective_kb_ids) =
        resolve_conversation_scope(&state, &actor, conversation_id, &[]).await?;

    let failed_msg = state
        .repository
        .get_message(actor.tenant_id, message_id)
        .await?
        .ok_or_else(AppError::message_not_found)?;
    if failed_msg.conversation_id != conversation_id {
        return Err(AppError::message_not_found());
    }
    if failed_msg.status != MessageStatus::Failed && failed_msg.status != MessageStatus::Cancelled {
        return Err(AppError::invalid_message_state());
    }
    let parent_id = failed_msg
        .parent_message_id
        .ok_or_else(AppError::invalid_message_state)?;

    let assistant_message_id = Uuid::new_v4();
    let assistant_message = ConversationMessage {
        id: assistant_message_id,
        conversation_id: session.id,
        tenant_id: actor.tenant_id,
        user_id: actor.user_id,
        role: MessageRole::Assistant,
        content: String::new(),
        status: MessageStatus::Answering,
        parent_message_id: Some(parent_id),
        retry_of_message_id: Some(message_id),
        client_request_id: None,
        confidence: None,
        no_answer_reason: None,
        error_code: None,
        error_message: None,
        agent_mode: None,
        prompt_versions: None,
        created_at: now(),
        completed_at: None,
    };
    state
        .repository
        .create_message(assistant_message.clone())
        .await?;

    let user_message = state
        .repository
        .get_message(actor.tenant_id, parent_id)
        .await?
        .ok_or_else(AppError::message_not_found)?;

    let (tx, rx) = unbounded_channel::<Result<Event, Infallible>>();
    let tx2 = tx.clone();
    let _ = tx2.send(Ok(SseEvent::MessageCreated {
        user_message_id: parent_id,
        assistant_message_id,
    }
    .to_sse_event()));

    let repo = state.repository.clone();
    let cache = state.cache.clone();
    let kernel = state.agent_kernel;
    let config = state.config.clone();

    tokio::spawn(async move {
        if let Err(e) = run_agent_pipeline(
            repo,
            cache,
            kernel,
            config,
            actor,
            session.id,
            parent_id,
            assistant_message_id,
            user_message.content,
            effective_kb_ids,
            tx2,
        )
        .await
        {
            error!("retry agent pipeline failed: {e:?}");
        }
    });

    Ok(Sse::new(UnboundedReceiverStream::new(rx)))
}

async fn submit_feedback(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path((conversation_id, message_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<SubmitFeedbackRequest>,
) -> Result<Json<FeedbackResponse>, AppError> {
    let session = state
        .repository
        .get_session(actor.tenant_id, conversation_id)
        .await?
        .ok_or_else(AppError::conversation_not_found)?;
    let message = state
        .repository
        .get_message(actor.tenant_id, message_id)
        .await?
        .ok_or_else(AppError::message_not_found)?;
    if message.conversation_id != session.id || message.role != MessageRole::Assistant {
        return Err(AppError::message_not_found());
    }

    let feedback = Feedback {
        id: Uuid::new_v4(),
        assistant_message_id: message_id,
        user_id: actor.user_id,
        rating: req.rating,
        reason: req.reason,
        comment: req.comment,
        correction: req.correction,
        created_at: now(),
    };
    state.repository.save_feedback(feedback.clone()).await?;

    // Negative feedback invalidates the cache key for this answer's query scope.
    if feedback.rating == crate::models::feedback::Rating::Down {
        if let Some(parent_id) = message.parent_message_id {
            if let Ok(Some(parent)) = state
                .repository
                .get_message(actor.tenant_id, parent_id)
                .await
            {
                let kb_scope = match state.repository.get_query_trace(parent_id).await {
                    Ok(Some(trace)) if !trace.effective_kb_ids.is_empty() => trace.effective_kb_ids,
                    _ => session.kb_ids.clone(),
                };
                let doc_version_hash = state
                    .repository
                    .doc_version_hash(actor.tenant_id, &kb_scope)
                    .await?;
                let cache_key = cache_key(
                    "v1",
                    actor.tenant_id,
                    &kb_scope,
                    &parent.content,
                    &doc_version_hash,
                );
                let _ = state.cache.delete(&cache_key).await;
            }
        }
    }

    Ok(Json(FeedbackResponse {
        feedback_id: feedback.id,
        message_id,
        created_at: feedback.created_at,
    }))
}

async fn get_conversation(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(conversation_id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let session = state
        .repository
        .get_session(actor.tenant_id, conversation_id)
        .await?
        .ok_or_else(AppError::conversation_not_found)?;
    Ok(Json(json!({
        "conversation_id": session.id,
        "title": session.title,
        "kb_ids": session.kb_ids,
        "status": session.status.to_string(),
        "summary": session.summary,
        "created_at": session.created_at,
        "updated_at": session.updated_at,
    })))
}

async fn delete_conversation(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(conversation_id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let mut session = state
        .repository
        .get_session(actor.tenant_id, conversation_id)
        .await?
        .ok_or_else(AppError::conversation_not_found)?;
    session.status = crate::models::ConversationStatus::Deleted;
    session.updated_at = now();
    state.repository.update_session(session).await?;
    Ok(Json(
        json!({"conversation_id": conversation_id, "status": "deleted"}),
    ))
}

async fn get_message_traces(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path((conversation_id, message_id)): Path<(Uuid, Uuid)>,
) -> Result<impl IntoResponse, AppError> {
    let session = state
        .repository
        .get_session(actor.tenant_id, conversation_id)
        .await?
        .ok_or_else(AppError::conversation_not_found)?;
    let message = state
        .repository
        .get_message(actor.tenant_id, message_id)
        .await?
        .ok_or_else(AppError::message_not_found)?;
    if message.conversation_id != session.id {
        return Err(AppError::message_not_found());
    }

    let agent_trace = state.repository.get_agent_trace(message_id).await?;
    let query_trace = if let Some(parent_id) = message.parent_message_id {
        state.repository.get_query_trace(parent_id).await?
    } else {
        None
    };
    let retrieval_traces = if let Some(parent_id) = message.parent_message_id {
        state.repository.get_retrieval_traces(parent_id).await?
    } else {
        vec![]
    };

    Ok(Json(json!({
        "message_id": message_id,
        "agent_trace": agent_trace,
        "query_trace": query_trace,
        "retrieval_traces": retrieval_traces,
    })))
}
