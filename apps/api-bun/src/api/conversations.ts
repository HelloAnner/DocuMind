// 移植自 apps/api-rs/src/api/conversations.rs —— 会话/消息/反馈/轨迹 HTTP 层
import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { PiAgentKernel, buildPiStreamFn } from '../agent/pi/index.ts';
import { requirePermission } from '../auth/permissions.ts';
import { spawnTitleUpdate } from '../conversation_title.ts';
import { chatModelCatalog, resolveChatModel } from '../chat_models.ts';
import { AppError } from '../errors.ts';
import { nowRfc3339 } from '../infra/time.ts';
import { newUuid } from '../infra/uuid.ts';
import type { AppEnv } from '../http/types.ts';
import type { ConversationFileListResponse } from '../models/conversation_file.ts';
import type { ConversationSession, CreateConversationRequest } from '../models/conversation.ts';
import type {
  DeleteFeedbackResponse, Feedback, FeedbackResponse, SubmitFeedbackRequest,
} from '../models/feedback.ts';
import { feedbackToResponse } from '../models/feedback.ts';
import type { CurrentActor } from '../models/identity.ts';
import type { ConversationMessage, MessageResponse, SendMessageRequest } from '../models/message.ts';
import { RuntimeEventFactory, sseProtocolFromHeaders } from './runtime_events.ts';
import { SseSink, sendExecutionStarted, type PipelineContext } from './conversations_sse.ts';
import { runAgentPipeline } from './conversations_pipeline.ts';
import { requireScope } from './external_api.ts';
import {
  describeError, intersectKbIds, messageToResponse, ownedSession, requestedKbScope,
  resolveConversationScope, uuidParam, validateFeedbackTarget,
} from './conversations_support.ts';

export { externalApiRouter } from './external_routes.ts';

const DEFAULT_LIMIT = 20;
const MAX_TITLE_CHARS = 200;

interface UpdateConversationRequest { title?: unknown; kb_ids?: unknown; }

export function conversationsRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/chat/models', chatModelsHandler);
  router.post('/api/conversations', createConversationHandler);
  router.get('/api/conversations', listConversationsHandler);
  router.get('/api/conversations/:conversation_id', getConversationHandler);
  router.patch('/api/conversations/:conversation_id', updateConversationHandler);
  router.delete('/api/conversations/:conversation_id', deleteConversationHandler);
  router.get('/api/conversations/:conversation_id/messages', getMessagesHandler);
  router.post('/api/conversations/:conversation_id/messages', sendMessageHandler);
  router.get('/api/conversations/:conversation_id/files', listConversationFilesHandler);
  router.get(
    '/api/conversations/:conversation_id/messages/:message_id/traces', getMessageTracesHandler);
  router.post(
    '/api/conversations/:conversation_id/messages/:message_id/cancel', cancelMessageHandler);
  router.post(
    '/api/conversations/:conversation_id/messages/:message_id/retry', retryMessageHandler);
  router.post(
    '/api/conversations/:conversation_id/messages/:message_id/feedback', submitFeedbackHandler);
  router.delete(
    '/api/conversations/:conversation_id/messages/:message_id/feedback', deleteFeedbackHandler);
  return router;
}

function chatModelsHandler(c: Context<AppEnv>): Response {
  return c.json(chatModelCatalog(c.get('appState').config));
}

export async function createConversationHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'chat.ask');
  const request = await c.req.json() as CreateConversationRequest;
  if (!Array.isArray(request.kb_ids)) {
    // Rust: CreateConversationRequest.kb_ids 无 serde default，缺字段时 axum 直接 422
    throw AppError.badRequest('INVALID_REQUEST_BODY', 'kb_ids 字段必填');
  }
  const kbIds = requestedKbScope(request.kb_ids, actor.allowed_kb_ids);
  const session: ConversationSession = {
    id: newUuid(),
    tenant_id: actor.tenant_id,
    user_id: actor.user_id,
    title: request.title ?? '新会话',
    kb_ids: kbIds,
    status: 'active',
    summary: null,
    created_at: nowRfc3339(),
    updated_at: nowRfc3339(),
  };
  await state.repository.createSession(session);
  return c.json({
    conversation_id: session.id,
    title: session.title,
    kb_ids: session.kb_ids,
    created_at: session.created_at,
    updated_at: session.updated_at,
  });
}

export async function listConversationsHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireApiScopeIfNeeded(actor, 'conversations:read');
  const rawLimit = c.req.query('limit');
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit !== '') {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw AppError.badRequest('INVALID_QUERY', 'limit 必须是非负整数');
    }
    limit = parsed;
  }
  const cursor = c.req.query('cursor') ?? null;
  const response = await state.repository.listSessions(
    actor.tenant_id, actor.user_id, limit, cursor);
  return c.json(response);
}

export async function getConversationHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireApiScopeIfNeeded(actor, 'conversations:read');
  const session = await ownedSession(state, actor, uuidParam(c, 'conversation_id'));
  return c.json({
    conversation_id: session.id,
    title: session.title,
    kb_ids: session.kb_ids,
    status: session.status,
    summary: session.summary,
    created_at: session.created_at,
    updated_at: session.updated_at,
  });
}

async function updateConversationHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  const conversationId = uuidParam(c, 'conversation_id');
  const request = await c.req.json() as UpdateConversationRequest;
  const hasTitle = request.title !== undefined;
  const hasKbIds = request.kb_ids !== undefined;
  if (!hasTitle && !hasKbIds) {
    throw AppError.badRequest('INVALID_REQUEST_BODY', 'title 或 kb_ids 字段必填');
  }

  let title: string | undefined;
  if (hasTitle) {
    if (typeof request.title !== 'string') {
      throw AppError.badRequest('INVALID_REQUEST_BODY', 'title 必须是字符串');
    }
    title = request.title.trim();
    if (title === '') {
      throw AppError.badRequest('EMPTY_CONVERSATION_TITLE', '会话标题不能为空');
    }
    if ([...title].length > MAX_TITLE_CHARS) {
      throw AppError.badRequest('CONVERSATION_TITLE_TOO_LONG', '会话标题不能超过 200 个字');
    }
  }

  let kbIds: string[] | undefined;
  if (hasKbIds) {
    if (!Array.isArray(request.kb_ids)
      || request.kb_ids.some((id: unknown) => typeof id !== 'string')) {
      throw AppError.badRequest('INVALID_REQUEST_BODY', 'kb_ids 必须是字符串数组');
    }
    kbIds = requestedKbScope(request.kb_ids as string[], actor.allowed_kb_ids);
  }

  if (title !== undefined) {
    const updated = await state.repository.updateSessionTitle(
      actor.tenant_id, actor.user_id, conversationId, title, true);
    if (!updated) throw AppError.conversationNotFound();
  }
  const session = await ownedSession(state, actor, conversationId);
  if (kbIds !== undefined) {
    session.kb_ids = kbIds;
    session.updated_at = nowRfc3339();
    await state.repository.updateSession(session);
  }
  return c.json({
    conversation_id: conversationId,
    title: session.title,
    kb_ids: session.kb_ids,
    updated_at: session.updated_at,
  });
}

async function deleteConversationHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  const conversationId = uuidParam(c, 'conversation_id');
  const session = await state.repository.getSession(actor.tenant_id, conversationId);
  if (session === null) throw AppError.conversationNotFound();
  if (session.user_id !== actor.user_id || session.status !== 'active') {
    throw AppError.conversationNotFound();
  }
  session.status = 'deleted';
  session.updated_at = nowRfc3339();
  await state.repository.updateSession(session);
  return c.json({ conversation_id: conversationId, status: 'deleted' });
}

export async function getMessagesHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireApiScopeIfNeeded(actor, 'conversations:read');
  const session = await ownedSession(state, actor, uuidParam(c, 'conversation_id'));
  const messages = await state.repository.getMessages(actor.tenant_id, session.id);
  const responses: MessageResponse[] = [];
  for (const message of messages) {
    responses.push(await messageToResponse(state.repository, message, actor.user_id));
  }
  return c.json({ conversation_id: session.id, messages: responses });
}

async function listConversationFilesHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  const conversationId = uuidParam(c, 'conversation_id');
  const session = await state.repository.getSession(actor.tenant_id, conversationId);
  if (session === null || session.user_id !== actor.user_id || session.status !== 'active') {
    throw AppError.conversationNotFound();
  }
  const configuredKbIds = session.kb_ids.length === 0
    ? [...actor.allowed_kb_ids]
    : session.kb_ids;
  const effectiveKbIds = intersectKbIds(configuredKbIds, actor.allowed_kb_ids);
  const files = await state.repository.listConversationFiles(
    actor.tenant_id, session.id, effectiveKbIds);
  const body: ConversationFileListResponse = { conversation_id: session.id, files: files };
  return c.json(body);
}

export async function sendMessageHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'chat.ask');
  const conversationId = uuidParam(c, 'conversation_id');
  const request = await c.req.json() as SendMessageRequest;
  if (typeof request.content !== 'string') {
    throw AppError.badRequest('INVALID_REQUEST_BODY', 'content 字段必填');
  }
  const content = request.content.trim();
  if (content === '') throw AppError.badRequest('EMPTY_MESSAGE', '消息内容不能为空');
  const scope = await resolveConversationScope(
    state, actor, conversationId, request.kb_ids ?? []);
  const session = scope.session;
  const modelSettings = resolveChatModel(
    state.config, request.model_id, request.thinking_enabled);
  const agentKernel = new PiAgentKernel({
    ...state.agentKernel.options,
    settings: modelSettings,
    streamFn: buildPiStreamFn(modelSettings),
  });

  const clientRequestId = request.client_request_id ?? null;
  if (clientRequestId !== null) {
    const existing = await state.repository.findMessageByClientRequestId(
      actor.tenant_id, actor.user_id, clientRequestId);
    if (existing !== null && existing.conversation_id === conversationId) {
      throw AppError.clientRequestConflict();
    }
  }

  const userMessage: ConversationMessage = {
    id: newUuid(),
    conversation_id: session.id,
    tenant_id: actor.tenant_id,
    user_id: actor.user_id,
    role: 'user',
    content: content,
    status: 'completed',
    parent_message_id: null,
    retry_of_message_id: null,
    client_request_id: clientRequestId,
    confidence: null,
    no_answer_reason: null,
    error_code: null,
    error_message: null,
    agent_mode: null,
    prompt_versions: null,
    created_at: nowRfc3339(),
    completed_at: nowRfc3339(),
  };
  await state.repository.createMessage(userMessage);

  const assistantMessageId = newUuid();
  await state.repository.createMessage(
    assistantPlaceholder(session, actor, userMessage.id, assistantMessageId, null));

  const protocol = sseProtocolFromHeaders(c.req.raw.headers);
  // Rust 在返回 SSE 之前就 spawn 标题任务，管线跑完后再推 conversation.title.updated
  const titleUpdate = spawnTitleUpdate(
    state.repository, state.agentKernel.options.settings,
    actor.tenant_id, actor.user_id, session.id);

  return streamSSE(c, async (stream) => {
    const ctx = pipelineContext(stream, protocol, actor, session.id, assistantMessageId);
    sendExecutionStarted(ctx, userMessage.id, assistantMessageId, content);
    try {
      await runAgentPipeline({
        repo: state.repository,
        kernel: agentKernel,
        config: state.config,
        sql: state.sql,
        actor: actor,
        conversationId: session.id,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessageId,
        originalQuery: content,
        effectiveKbIds: scope.effectiveKbIds,
        ctx: ctx,
        titleUpdate: titleUpdate,
      });
    } catch (error) {
      console.error('[documind][conversations] agent pipeline failed: ' + describeError(error));
    }
    await ctx.sink.flush();
  });
}

async function cancelMessageHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  const conversationId = uuidParam(c, 'conversation_id');
  const messageId = uuidParam(c, 'message_id');
  const session = await state.repository.getSession(actor.tenant_id, conversationId);
  if (session === null) throw AppError.conversationNotFound();
  const message = await state.repository.getMessage(actor.tenant_id, messageId);
  if (message === null) throw AppError.messageNotFound();
  if (message.conversation_id !== conversationId) throw AppError.messageNotFound();
  if (message.status !== 'answering') throw AppError.invalidMessageState();
  message.status = 'cancelled';
  message.completed_at = nowRfc3339();
  await state.repository.updateMessage(message);
  return c.json({ message_id: message.id, status: message.status });
}

async function retryMessageHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  const conversationId = uuidParam(c, 'conversation_id');
  const messageId = uuidParam(c, 'message_id');
  // Rust 签名带 Json<RetryMessageRequest>，但 stream 字段未被读取：始终返回 SSE
  const scope = await resolveConversationScope(state, actor, conversationId, []);
  const session = scope.session;
  const failedMessage = await state.repository.getMessage(actor.tenant_id, messageId);
  if (failedMessage === null) throw AppError.messageNotFound();
  if (failedMessage.conversation_id !== conversationId) throw AppError.messageNotFound();
  if (failedMessage.status !== 'failed' && failedMessage.status !== 'cancelled') {
    throw AppError.invalidMessageState();
  }
  const parentId = failedMessage.parent_message_id;
  if (parentId === null) throw AppError.invalidMessageState();

  const assistantMessageId = newUuid();
  await state.repository.createMessage(
    assistantPlaceholder(session, actor, parentId, assistantMessageId, messageId));

  const userMessage = await state.repository.getMessage(actor.tenant_id, parentId);
  if (userMessage === null) throw AppError.messageNotFound();

  const protocol = sseProtocolFromHeaders(c.req.raw.headers);
  return streamSSE(c, async (stream) => {
    const ctx = pipelineContext(stream, protocol, actor, session.id, assistantMessageId);
    sendExecutionStarted(ctx, parentId, assistantMessageId, userMessage.content);
    try {
      await runAgentPipeline({
        repo: state.repository,
        kernel: state.agentKernel,
        config: state.config,
        sql: state.sql,
        actor: actor,
        conversationId: session.id,
        userMessageId: parentId,
        assistantMessageId: assistantMessageId,
        originalQuery: userMessage.content,
        effectiveKbIds: scope.effectiveKbIds,
        ctx: ctx,
        titleUpdate: null,
      });
    } catch (error) {
      console.error(
        '[documind][conversations] retry agent pipeline failed: ' + describeError(error));
    }
    await ctx.sink.flush();
  });
}

/** 新建的 answering 助手占位消息（发送与重试共用）。 */
function assistantPlaceholder(
  session: ConversationSession,
  actor: CurrentActor,
  parentId: string,
  assistantMessageId: string,
  retryOfMessageId: string | null,
): ConversationMessage {
  return {
    id: assistantMessageId,
    conversation_id: session.id,
    tenant_id: actor.tenant_id,
    user_id: actor.user_id,
    role: 'assistant',
    content: '',
    status: 'answering',
    parent_message_id: parentId,
    retry_of_message_id: retryOfMessageId,
    client_request_id: null,
    confidence: null,
    no_answer_reason: null,
    error_code: null,
    error_message: null,
    agent_mode: null,
    prompt_versions: null,
    created_at: nowRfc3339(),
    completed_at: null,
  };
}

async function submitFeedbackHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  const conversationId = uuidParam(c, 'conversation_id');
  const messageId = uuidParam(c, 'message_id');
  const request = await c.req.json() as SubmitFeedbackRequest;
  if (request.rating !== 'up' && request.rating !== 'down') {
    throw AppError.badRequest('INVALID_REQUEST_BODY', 'rating 只能是 up 或 down');
  }
  await validateFeedbackTarget(
    state, actor.tenant_id, actor.user_id, conversationId, messageId);
  const feedback: Feedback = {
    id: newUuid(),
    assistant_message_id: messageId,
    user_id: actor.user_id,
    rating: request.rating,
    reason: request.reason ?? null,
    comment: request.comment ?? null,
    correction: request.correction ?? null,
    created_at: nowRfc3339(),
    updated_at: nowRfc3339(),
  };
  const saved = await state.repository.upsertFeedback(feedback);
  const response: FeedbackResponse = feedbackToResponse(saved);
  return c.json(response);
}

async function deleteFeedbackHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  const conversationId = uuidParam(c, 'conversation_id');
  const messageId = uuidParam(c, 'message_id');
  await validateFeedbackTarget(
    state, actor.tenant_id, actor.user_id, conversationId, messageId);
  await state.repository.deleteFeedback(messageId, actor.user_id);
  const body: DeleteFeedbackResponse = { message_id: messageId };
  return c.json(body);
}

export async function getMessageTracesHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireApiScopeIfNeeded(actor, 'conversations:read');
  const session = await ownedSession(state, actor, uuidParam(c, 'conversation_id'));
  const messageId = uuidParam(c, 'message_id');
  const message = await state.repository.getMessage(actor.tenant_id, messageId);
  if (message === null) throw AppError.messageNotFound();
  if (message.conversation_id !== session.id) throw AppError.messageNotFound();
  const agentTrace = await state.repository.getAgentTrace(messageId);
  const parentId = message.parent_message_id;
  const queryTrace = parentId === null ? null : await state.repository.getQueryTrace(parentId);
  const retrievalTraces = parentId === null
    ? []
    : await state.repository.getRetrievalTraces(parentId);
  return c.json({
    message_id: messageId,
    agent_trace: agentTrace,
    query_trace: queryTrace,
    retrieval_traces: retrievalTraces,
  });
}

/** 对应 Rust require_api_scope_if_needed：只有 API Client 身份才校验 scope。 */
function requireApiScopeIfNeeded(actor: CurrentActor, scope: string): void {
  if (actor.api_client_id !== null) requireScope(actor, scope);
}

function pipelineContext(
  stream: import('hono/streaming').SSEStreamingApi,
  protocol: import('./runtime_events.ts').SseProtocol,
  actor: CurrentActor,
  conversationId: string,
  assistantMessageId: string,
): PipelineContext {
  return {
    sink: new SseSink(stream),
    protocol: protocol,
    factory: new RuntimeEventFactory(
      actor.tenant_id, actor.user_id, conversationId, assistantMessageId),
    abandoned: false,
  };
}
