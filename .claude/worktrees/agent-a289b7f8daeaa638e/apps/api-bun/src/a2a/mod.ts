// A2A 服务端：AgentCard 发现 + JSON-RPC message/stream（SSE）。
// 身份：Authorization: Bearer <Portal 一次性票据> -> Portal exchange-ticket -> 本地映射。
import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { PiAgentKernel, buildPiStreamFn } from '../agent/pi/index.ts';
import { requirePermission } from '../auth/permissions.ts';
import { resolveChatModel } from '../chat_models.ts';
import { toAppError } from '../errors.ts';
import { nowRfc3339 } from '../infra/time.ts';
import { newUuid } from '../infra/uuid.ts';
import type { AppEnv } from '../http/types.ts';
import type { ConversationMessage } from '../models/message.ts';
import type { CurrentActor } from '../models/identity.ts';
import {
  PortalAccountNotLinkedError, portalSystemEnterUrl, resolveA2APortalActor,
} from '../api/auth.ts';
import { RuntimeEventFactory } from '../api/runtime_events.ts';
import { sendExecutionStarted, type PipelineContext } from '../api/conversations_sse.ts';
import { runAgentPipeline } from '../api/conversations_pipeline.ts';
import { A2ASink } from './sink.ts';
import { A2A_MAX_CONTEXT_ID, resolveA2AConversation } from './thread.ts';
import {
  receiveA2AAttachments,
  type A2AAttachmentResult,
} from './attachments.ts';

export { A2AFrameMapper, A2ASink } from './sink.ts';
export { resolveA2AConversation } from './thread.ts';
export {
  A2A_ATTACHMENT_MAX_BYTES, A2A_MAX_ATTACHMENTS,
  extractFileParts, receiveA2AAttachments, type A2AAttachmentResult,
} from './attachments.ts';

export const A2A_SYSTEM_CODE = 'documind';

export interface AgentCardSkill {
  id: string; name: string; description: string; examples: string[];
}
export interface AgentCard {
  name: string; description: string; url: string; version: string;
  capabilities: { streaming: boolean };
  defaultInputModes: string[]; defaultOutputModes: string[];
  skills: AgentCardSkill[];
  securitySchemes: Record<string, { type: string; scheme: string }>;
  security: Array<Record<string, string[]>>;
}

/** AgentCard 是纯函数：publicBase 已经去掉尾斜杠，例如 https://documind.example.com/documind */
export function buildAgentCard(publicBase: string): AgentCard {
  const base = publicBase.replace(/\/+$/, '');
  return {
    name: 'Documind 文档 Agent',
    description: '企业文档问答系统 · 基于知识库检索生成带引用来源的回答',
    url: `${base}/a2a`,
    version: '1.0.0',
    capabilities: { streaming: true },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [
      {
        id: 'document-qa',
        name: '文档检索问答',
        description: '在企业知识库中检索并回答制度、流程、产品文档问题',
        examples: ['查一下差旅报销标准是多少'],
      },
      {
        id: 'clause-summary',
        name: '条款摘要',
        description: '归纳合同、制度、条款要点并标注原文出处',
        examples: ['总结这份合同的违约责任条款'],
      },
      {
        id: 'citation-source',
        name: '引用来源',
        description: '回答附带原文引用、文档标题与页码，便于核对',
        examples: ['年假审批流程在哪份文件里规定？'],
      },
    ],
    securitySchemes: { portal: { type: 'http', scheme: 'bearer' } },
    security: [{ portal: [] }],
  };
}

/** 优先用显式配置的公开基址，否则按请求 origin + 前缀推断。 */
export function publicBaseForRequest(url: string, path: string): string {
  const configured = process.env.DOCUMIND_PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const prefix = path.replace(/\/\.well-known\/agent-card\.json$/, '');
  return new URL(url).origin + prefix;
}

export function a2aRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/.well-known/agent-card.json', (c) =>
    c.json(buildAgentCard(publicBaseForRequest(c.req.url, c.req.path))));
  router.post('/a2a', a2aStreamHandler);
  return router;
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown;
}

export async function a2aStreamHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  let request: JsonRpcRequest;
  try {
    request = await c.req.json() as JsonRpcRequest;
  } catch {
    return rpcErrorResponse(400, null, -32700, '请求体不是合法 JSON', { reason: 'parse_error' });
  }
  if (request === null || typeof request !== 'object') {
    return rpcErrorResponse(400, null, -32600, '无效的 JSON-RPC 请求', { reason: 'invalid_request' });
  }
  const id = normalizeRpcId(request.id);
  if (request.method !== 'message/stream') {
    return rpcErrorResponse(400, id, -32601, '仅支持 method=message/stream', { reason: 'method_not_found' });
  }
  const message = (request.params as { message?: unknown } | undefined)?.message;
  if (message === null || typeof message !== 'object') {
    return rpcErrorResponse(400, id, -32602, '缺少 params.message', { reason: 'invalid_params' });
  }
  const messageRecord = message as Record<string, unknown>;
  const contextId = resolveContextId(messageRecord);
  const content = normalizeQuestion(partsText(messageRecord.parts));
  if (content === '') {
    return rpcErrorResponse(400, id, -32602, '消息文本不能为空', { reason: 'empty_message' });
  }

  // 1) Portal 票据 -> 本地用户/租户（未关联 -> 409 account_not_linked）
  const ticket = bearerToken(c.req.raw.headers.get('authorization'));
  if (ticket === null) {
    return rpcErrorResponse(401, id, -32000, '缺少 Portal 票据', { reason: 'missing_ticket' });
  }
  let actor: CurrentActor;
  try {
    actor = await resolveA2APortalActor(state, ticket);
  } catch (error) {
    if (error instanceof PortalAccountNotLinkedError) {
      return rpcErrorResponse(409, id, -32001, '门户账号尚未关联', {
        reason: 'account_not_linked', link_url: error.linkUrl,
      });
    }
    return rpcErrorFromAppError(id, error);
  }

  // 2) 复用现有 Portal 权限校验
  try {
    requirePermission(actor, 'chat.ask');
  } catch (error) {
    return rpcErrorFromAppError(id, error);
  }

  // 3) contextId -> 本地会话（幂等）
  let conversationId: string;
  try {
    const session = await resolveA2AConversation(state, actor, contextId);
    conversationId = session.id;
  } catch (error) {
    return rpcErrorFromAppError(id, error);
  }

  let kernel: PiAgentKernel;
  try {
    const modelSettings = resolveChatModel(state.config, undefined, undefined);
    kernel = new PiAgentKernel({
      ...state.agentKernel.options,
      settings: modelSettings,
      streamFn: buildPiStreamFn(modelSettings),
    });
  } catch (error) {
    return rpcErrorFromAppError(id, error);
  }
  // 4) Portal 附件：下载 -> 落库 user_file -> 抽取 fileContext。
  //    任何单附件失败都只降级为 status-update 提示，不阻断文本问答。
  let attachments: A2AAttachmentResult;
  try {
    attachments = await receiveA2AAttachments(messageRecord.parts, {
      sql: state.sql,
      storage: state.storage,
      actor,
      conversationId,
    });
  } catch (error) {
    console.error('[documind][a2a] attachment receive failed: '
      + (error instanceof Error ? error.message : String(error)));
    attachments = { fileIds: [], fileContext: '', notices: ['附件接收失败，已忽略'] };
  }

  const userMessage = messageRecord2User(conversationId, actor, content);
  const assistantMessageId = newUuid();
  const assistantMessage = assistantPlaceholder(conversationId, actor, userMessage.id, assistantMessageId);
  try {
    await state.repository.createMessagePair(userMessage, assistantMessage, attachments.fileIds);
  } catch (error) {
    return rpcErrorFromAppError(id, error);
  }

  const effectiveKbIds = actor.allowed_kb_ids;
  return streamSSE(c, async (stream) => {
    const sink = new A2ASink(stream, { rpcId: id, taskId: assistantMessageId, contextId });
    const ctx: PipelineContext = {
      sink,
      protocol: 'atom',
      factory: new RuntimeEventFactory(actor.tenant_id, actor.user_id, conversationId, assistantMessageId),
      abandoned: false,
    };
    sendExecutionStarted(ctx, userMessage.id, assistantMessageId, content);
    for (const notice of attachments.notices) sink.sendStatus(notice);
    try {
      await runAgentPipeline({
        repo: state.repository,
        kernel,
        config: state.config,
        sql: state.sql,
        actor,
        conversationId,
        userMessageId: userMessage.id,
        assistantMessageId,
        originalQuery: content,
        effectiveKbIds,
        fileIds: attachments.fileIds,
        fileContext: attachments.fileContext,
        ctx,
        titleUpdate: null,
      });
    } catch (error) {
      console.error('[documind][a2a] agent pipeline failed: '
        + (error instanceof Error ? error.message : String(error)));
    }
    await sink.flush();
  });
}

// ---------- JSON-RPC helpers ----------

function normalizeRpcId(value: unknown): JsonRpcId {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

function bearerToken(header: string | null): string | null {
  if (header === null || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

function resolveContextId(message: Record<string, unknown>): string {
  const context = typeof message.contextId === 'string' ? message.contextId.trim() : '';
  if (context !== '' && [...context].length <= A2A_MAX_CONTEXT_ID) return context;
  const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
  if (messageId !== '' && [...messageId].length <= A2A_MAX_CONTEXT_ID) return messageId;
  return newUuid();
}

function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => {
    if (part === null || typeof part !== 'object') return '';
    const record = part as Record<string, unknown>;
    return record.kind === 'text' && typeof record.text === 'string' ? record.text : '';
  }).join('');
}

/** 去掉开头的 @Handle；去掉后为空则保留原文。 */
export function normalizeQuestion(text: string): string {
  const trimmed = text.trim();
  const stripped = trimmed.replace(/^@[A-Za-z0-9_\-\u4e00-\u9fff]+\s*/u, '').trim();
  return stripped === '' ? trimmed : stripped;
}

function rpcErrorFromAppError(id: JsonRpcId, error: unknown): Response {
  const appError = toAppError(error);
  return rpcErrorResponse(
    appError.httpStatus, id, -32000, appError.message,
    { reason: appError.code.toLowerCase() });
}

function rpcErrorResponse(
  status: number, id: JsonRpcId, code: number, message: string,
  data?: Record<string, unknown>,
): Response {
  return Response.json({
    jsonrpc: '2.0', id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }, { status });
}

// ---------- 消息持久化 ----------

function messageRecord2User(
  conversationId: string, actor: CurrentActor, content: string,
): ConversationMessage {
  return {
    id: newUuid(), conversation_id: conversationId,
    tenant_id: actor.tenant_id, user_id: actor.user_id,
    role: 'user', content, status: 'completed',
    parent_message_id: null, retry_of_message_id: null, client_request_id: null,
    confidence: null, no_answer_reason: null, error_code: null, error_message: null,
    agent_mode: null, prompt_versions: null, answer_source: 'rag',
    correction_id: null, correction_version_id: null,
    correction_match_type: null, correction_match_score: null,
    created_at: nowRfc3339(), completed_at: nowRfc3339(),
  };
}

function assistantPlaceholder(
  conversationId: string, actor: CurrentActor, parentId: string, assistantMessageId: string,
): ConversationMessage {
  return {
    id: assistantMessageId, conversation_id: conversationId,
    tenant_id: actor.tenant_id, user_id: actor.user_id,
    role: 'assistant', content: '', status: 'answering',
    parent_message_id: parentId, retry_of_message_id: null, client_request_id: null,
    confidence: null, no_answer_reason: null, error_code: null, error_message: null,
    agent_mode: null, prompt_versions: null, answer_source: 'rag',
    correction_id: null, correction_version_id: null,
    correction_match_type: null, correction_match_score: null,
    created_at: nowRfc3339(), completed_at: null,
  };
}
