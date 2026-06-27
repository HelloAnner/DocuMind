use std::convert::Infallible;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
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
use crate::api::runtime_events::{tool_step, RuntimeEventFactory, SseProtocol};
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
    headers: HeaderMap,
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
    let db_pool = state.db_pool.clone();
    let protocol = SseProtocol::from_headers(&headers);
    let mut runtime_events = RuntimeEventFactory::new(
        actor.tenant_id,
        actor.user_id,
        session.id,
        assistant_message_id,
    );

    send_execution_started(
        &tx2,
        protocol,
        &mut runtime_events,
        user_message.id,
        assistant_message_id,
        &content,
    );

    tokio::spawn(async move {
        if let Err(e) = run_agent_pipeline(
            repo,
            cache,
            kernel,
            config,
            db_pool,
            actor,
            session.id,
            user_message.id,
            assistant_message_id,
            content,
            effective_kb_ids,
            tx2,
            protocol,
            runtime_events,
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
    db_pool: Option<sqlx::PgPool>,
    actor: ActorScope,
    conversation_id: Uuid,
    user_message_id: Uuid,
    assistant_message_id: Uuid,
    original_query: String,
    effective_kb_ids: Vec<Uuid>,
    tx: tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>,
    protocol: SseProtocol,
    runtime_events: RuntimeEventFactory,
) -> Result<(), AppError> {
    let runtime_events = Arc::new(Mutex::new(runtime_events));
    // Build history from previous completed QA pairs.
    let history = build_history(
        db_pool.as_ref(),
        &repo,
        actor.tenant_id,
        conversation_id,
        user_message_id,
    )
    .await?;
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
    let answer_cache_enabled = should_cache(&original_query);
    let cached_answer = if answer_cache_enabled {
        let cached = cache.get(&cache_key).await?;
        match cached {
            Some(cached)
                if cached_answer_valid(&repo, actor.tenant_id, &effective_kb_ids, &cached)
                    .await? =>
            {
                Some(cached)
            }
            Some(_) => {
                cache.delete(&cache_key).await?;
                None
            }
            None => None,
        }
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
            mode,
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
        let progress_protocol = protocol;
        let progress_runtime_events = runtime_events.clone();
        tokio::spawn(async move {
            while let Some(progress) = progress_rx.recv().await {
                send_progress_event(
                    &progress_sse_tx,
                    progress_protocol,
                    &progress_runtime_events,
                    assistant_message_id,
                    progress,
                );
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
                    protocol,
                    &runtime_events,
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
            send_execution_cancelled(&tx, protocol, &runtime_events);
            return Ok(());
        }
        match item {
            AnswerStreamItem::Delta { text } => {
                answer_text.push_str(&text);
                send_answer_delta(&tx, protocol, &runtime_events, assistant_message_id, text);
            }
            AnswerStreamItem::Citation { citation } => {
                citations.push(citation.clone());
                send_citation_delta(
                    &tx,
                    protocol,
                    &runtime_events,
                    assistant_message_id,
                    citation,
                );
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
        send_answer_failed(
            &tx,
            protocol,
            &runtime_events,
            assistant_message_id,
            code.clone(),
            message.clone(),
        );
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
        send_execution_cancelled(&tx, protocol, &runtime_events);
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
        .map(|c| Citation {
            id: Uuid::new_v4(),
            assistant_message_id,
            index: c.index,
            chunk_id: c.chunk_id,
            doc_id: c.doc_id,
            doc_title: c.doc_title.clone(),
            page_range: c.page_range.clone(),
            heading_path: vec![],
            quote: c.quote.clone(),
            score: c.score,
            source_status: c.source_status.clone(),
            anchor: c.anchor.clone(),
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

    send_answer_completed(
        &tx,
        protocol,
        &runtime_events,
        assistant_message_id,
        confidence,
        usage.clone(),
    );

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
    protocol: SseProtocol,
    runtime_events: &Arc<Mutex<RuntimeEventFactory>>,
) -> Result<(), AppError> {
    send_answer_failed(
        tx,
        protocol,
        runtime_events,
        assistant_message_id,
        code.clone(),
        message.clone(),
    );
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

fn send_legacy_event(
    tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>,
    event: SseEvent,
) {
    let _ = tx.send(Ok(event.to_sse_event()));
}

fn send_runtime_event(
    tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>,
    runtime_events: &Arc<Mutex<RuntimeEventFactory>>,
    event_type: &str,
    payload: serde_json::Value,
) {
    match runtime_events.lock() {
        Ok(mut factory) => {
            let _ = tx.send(Ok(factory.event(event_type, payload)));
        }
        Err(err) => {
            error!("runtime event factory lock failed: {err}");
        }
    }
}

fn send_runtime_step_event(
    tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>,
    runtime_events: &Arc<Mutex<RuntimeEventFactory>>,
    event_type: &str,
    tool_call_id: &str,
    name: &str,
    payload: serde_json::Value,
) {
    match runtime_events.lock() {
        Ok(mut factory) => {
            let _ = tx.send(Ok(factory.event_with_step(
                event_type,
                Some(tool_step(tool_call_id, name)),
                payload,
            )));
        }
        Err(err) => {
            error!("runtime event factory lock failed: {err}");
        }
    }
}

fn send_execution_started(
    tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>,
    protocol: SseProtocol,
    runtime_events: &mut RuntimeEventFactory,
    user_message_id: Uuid,
    assistant_message_id: Uuid,
    task: &str,
) {
    match protocol {
        SseProtocol::Legacy => send_legacy_event(
            tx,
            SseEvent::MessageCreated {
                user_message_id,
                assistant_message_id,
            },
        ),
        SseProtocol::Atom => {
            let event = runtime_events.event(
                "execution.started",
                json!({
                    "task": task,
                    "plan_mode": false,
                    "user_message_id": user_message_id,
                    "assistant_message_id": assistant_message_id,
                }),
            );
            let _ = tx.send(Ok(event));
        }
    }
}

fn send_progress_event(
    tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>,
    protocol: SseProtocol,
    runtime_events: &Arc<Mutex<RuntimeEventFactory>>,
    message_id: Uuid,
    progress: AgentProgress,
) {
    if protocol == SseProtocol::Legacy {
        let event = progress_to_sse_event(message_id, progress);
        send_legacy_event(tx, event);
        return;
    }

    match progress {
        AgentProgress::StatusUpdated { status } => {
            let (tool_call_id, name, display) = atom_step_for_status(status);
            send_runtime_step_event(
                tx,
                runtime_events,
                "tool.call.started",
                &tool_call_id,
                &name,
                json!({
                    "tool_call_id": tool_call_id,
                    "name": name,
                    "arguments": { "stage": status },
                    "display_name": display,
                }),
            );
        }
        AgentProgress::RewriteCompleted {
            rewritten_query,
            keywords,
        } => send_runtime_step_event(
            tx,
            runtime_events,
            "tool.call.result",
            "query_rewrite",
            "query_rewrite",
            json!({
                "tool_call_id": "query_rewrite",
                "name": "query_rewrite",
                "status": "succeeded",
                "result": rewritten_query,
                "display": {
                    "component": "DocuMindStageCard",
                    "data": {
                        "label": "查询改写",
                        "keywords": keywords,
                    }
                }
            }),
        ),
        AgentProgress::RetrievalCompleted { chunk_count } => send_runtime_step_event(
            tx,
            runtime_events,
            "tool.call.result",
            "hybrid_retrieval",
            "hybrid_retrieval",
            json!({
                "tool_call_id": "hybrid_retrieval",
                "name": "hybrid_retrieval",
                "status": "succeeded",
                "result": format!("retrieved {chunk_count} chunks"),
                "display": {
                    "component": "DocuMindStageCard",
                    "data": {
                        "label": "混合检索",
                        "chunk_count": chunk_count,
                    }
                }
            }),
        ),
        AgentProgress::RerankCompleted { top_chunk_ids } => send_runtime_step_event(
            tx,
            runtime_events,
            "tool.call.result",
            "rerank",
            "rerank",
            json!({
                "tool_call_id": "rerank",
                "name": "rerank",
                "status": "succeeded",
                "result": "rerank completed",
                "display": {
                    "component": "DocuMindStageCard",
                    "data": {
                        "label": "重排序",
                        "top_chunk_ids": top_chunk_ids,
                    }
                }
            }),
        ),
    }
}

fn send_answer_delta(
    tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>,
    protocol: SseProtocol,
    runtime_events: &Arc<Mutex<RuntimeEventFactory>>,
    message_id: Uuid,
    text: String,
) {
    match protocol {
        SseProtocol::Legacy => send_legacy_event(tx, SseEvent::AnswerDelta { message_id, text }),
        SseProtocol::Atom => send_runtime_event(
            tx,
            runtime_events,
            "response.delta",
            json!({ "delta": text }),
        ),
    }
}

fn send_citation_delta(
    tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>,
    protocol: SseProtocol,
    runtime_events: &Arc<Mutex<RuntimeEventFactory>>,
    message_id: Uuid,
    citation: CitationOutput,
) {
    match protocol {
        SseProtocol::Legacy => {
            send_legacy_event(
                tx,
                SseEvent::CitationDelta {
                    message_id,
                    citation,
                },
            );
        }
        SseProtocol::Atom => send_runtime_event(
            tx,
            runtime_events,
            "sources.reported",
            json!({
                "sources": [{
                    "title": citation.doc_title.clone(),
                    "uri": citation.doc_id.to_string(),
                    "documind_citation": citation,
                }]
            }),
        ),
    }
}

fn send_answer_completed(
    tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>,
    protocol: SseProtocol,
    runtime_events: &Arc<Mutex<RuntimeEventFactory>>,
    message_id: Uuid,
    confidence: Confidence,
    usage: Option<crate::models::Usage>,
) {
    match protocol {
        SseProtocol::Legacy => send_legacy_event(
            tx,
            SseEvent::AnswerCompleted {
                message_id,
                confidence,
                usage,
            },
        ),
        SseProtocol::Atom => {
            send_runtime_event(
                tx,
                runtime_events,
                "response.completed",
                json!({ "finish_reason": "stop", "confidence": confidence.to_string() }),
            );
            if let Some(usage) = usage {
                let total_tokens = usage.input_tokens + usage.output_tokens;
                send_runtime_event(
                    tx,
                    runtime_events,
                    "usage.reported",
                    json!({
                        "prompt_tokens": usage.input_tokens,
                        "completion_tokens": usage.output_tokens,
                        "total_tokens": total_tokens,
                    }),
                );
            }
            send_runtime_event(
                tx,
                runtime_events,
                "execution.completed",
                json!({ "summary": "执行成功" }),
            );
        }
    }
}

fn send_answer_failed(
    tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>,
    protocol: SseProtocol,
    runtime_events: &Arc<Mutex<RuntimeEventFactory>>,
    message_id: Uuid,
    code: String,
    message: String,
) {
    match protocol {
        SseProtocol::Legacy => send_legacy_event(
            tx,
            SseEvent::AnswerFailed {
                message_id,
                code,
                message,
            },
        ),
        SseProtocol::Atom => send_runtime_event(
            tx,
            runtime_events,
            "execution.failed",
            json!({
                "error": {
                    "code": code,
                    "message": message,
                    "source": "agent",
                    "recoverable": true,
                }
            }),
        ),
    }
}

fn send_execution_cancelled(
    tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>,
    protocol: SseProtocol,
    runtime_events: &Arc<Mutex<RuntimeEventFactory>>,
) {
    if protocol == SseProtocol::Atom {
        send_runtime_event(tx, runtime_events, "execution.cancelled", json!({}));
    }
}

fn atom_step_for_status(status: &str) -> (String, String, &'static str) {
    match status {
        "rewriting" => (
            "query_rewrite".to_string(),
            "query_rewrite".to_string(),
            "查询改写",
        ),
        "retrieving" => (
            "hybrid_retrieval".to_string(),
            "hybrid_retrieval".to_string(),
            "混合检索",
        ),
        "reranking" => ("rerank".to_string(), "rerank".to_string(), "重排序"),
        "generating" => (
            "answer_generation".to_string(),
            "answer_generation".to_string(),
            "生成答案",
        ),
        _ => (status.to_string(), status.to_string(), "执行步骤"),
    }
}

fn should_cache(query: &str) -> bool {
    let forbidden = ["最新", "今天", "刚刚", "现在"];
    !forbidden.iter().any(|w| query.contains(w))
}

async fn cached_answer_valid(
    repo: &Arc<dyn ConversationRepository>,
    tenant_id: Uuid,
    effective_kb_ids: &[Uuid],
    cached: &CachedAnswer,
) -> Result<bool, AppError> {
    if cached.confidence == Confidence::Low || cached.citations.is_empty() {
        return Ok(false);
    }

    Ok(repo
        .citations_valid_for_scope(tenant_id, effective_kb_ids, &cached.citations)
        .await?)
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
    db_pool: Option<&sqlx::PgPool>,
    repo: &Arc<dyn ConversationRepository>,
    tenant_id: Uuid,
    conversation_id: Uuid,
    exclude_user_message_id: Uuid,
) -> Result<Vec<ConversationTurn>, AppError> {
    let messages = repo.get_messages(tenant_id, conversation_id).await?;
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

    let mut turns: Vec<ConversationTurn> = vec![];

    // Walk through user messages in chronological order and pair each with its
    // completed assistant response. Retry/cancelled assistant messages are
    // excluded because they are not completed.
    let mut user_msgs: Vec<&ConversationMessage> = user_map.values().collect();
    user_msgs.sort_by_key(|m| m.created_at);

    for u in user_msgs {
        if let Some(a) = assistant_map
            .values()
            .find(|a| a.parent_message_id == Some(u.id))
        {
            if a.status == MessageStatus::Completed && !a.content.is_empty() {
                let raw_citations = repo.get_citations(a.id).await?;
                let mut resolved_citations = Vec::with_capacity(raw_citations.len());
                for citation in raw_citations {
                    if citation.doc_title.trim().is_empty() || citation.doc_title == "未命名文档"
                    {
                        resolved_citations.push(
                            document_title_for_citation(db_pool, tenant_id, citation.doc_id)
                                .await
                                .unwrap_or(citation.doc_title),
                        );
                    } else {
                        resolved_citations.push(citation.doc_title);
                    }
                }
                turns.push(ConversationTurn {
                    user_message: u.content.clone(),
                    assistant_answer: a.content.clone(),
                    citations: resolved_citations,
                });
            }
        }
    }

    Ok(turns)
}

async fn document_title_for_citation(
    db_pool: Option<&sqlx::PgPool>,
    tenant_id: Uuid,
    doc_id: Uuid,
) -> Option<String> {
    let pool = db_pool?;
    sqlx::query_scalar::<_, String>("SELECT title FROM documents WHERE tenant_id = $1 AND id = $2")
        .bind(tenant_id)
        .bind(doc_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
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
    headers: HeaderMap,
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
    let protocol = SseProtocol::from_headers(&headers);
    let mut runtime_events = RuntimeEventFactory::new(
        actor.tenant_id,
        actor.user_id,
        session.id,
        assistant_message_id,
    );
    send_execution_started(
        &tx2,
        protocol,
        &mut runtime_events,
        parent_id,
        assistant_message_id,
        &user_message.content,
    );

    let repo = state.repository.clone();
    let cache = state.cache.clone();
    let kernel = state.agent_kernel;
    let config = state.config.clone();
    let db_pool = state.db_pool.clone();

    tokio::spawn(async move {
        if let Err(e) = run_agent_pipeline(
            repo,
            cache,
            kernel,
            config,
            db_pool,
            actor,
            session.id,
            parent_id,
            assistant_message_id,
            user_message.content,
            effective_kb_ids,
            tx2,
            protocol,
            runtime_events,
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
