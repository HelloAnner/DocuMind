import { createMcpHandler, McpServer, type AuthInfo } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import * as z from 'zod/v4';
import { sendMessageHandler } from './api/conversations.ts';
import { actorFromApiHeaders, requireScope } from './api/external_api.ts';
import { recordAuditEvent } from './auth/audit.ts';
import { AppError } from './errors.ts';
import { nowRfc3339 } from './infra/time.ts';
import { newUuid } from './infra/uuid.ts';
import type { AppEnv } from './http/types.ts';
import type { ConversationSession } from './models/conversation.ts';
import type { CurrentActor } from './models/identity.ts';
import type { AppState } from './state.ts';

interface McpAuthInfo extends AuthInfo {
  actor: CurrentActor;
}

export function createDocumindMcpEndpoint(state: AppState) {
  const handler = createMcpHandler(({ authInfo }) => buildDocumindMcpServer(
    state, (authInfo as McpAuthInfo).actor,
  ));
  return async (c: Context<AppEnv>): Promise<Response> => {
    if (!validOrigin(c.req.raw)) return c.json({ error: 'origin_denied' }, 403);
    let actor: CurrentActor | null;
    try {
      actor = await actorFromApiHeaders(state, c.req.raw.headers);
    } catch {
      return c.json({ error: 'mcp_token_invalid' }, 401);
    }
    if (actor === null || actor.api_client_id === null || actor.api_token_id === null) {
      return c.json({ error: 'mcp_token_required' }, 401);
    }
    const expiresAt = actor.api_token_expires_at === null
      ? undefined
      : Math.floor(new Date(actor.api_token_expires_at).getTime() / 1000);
    if (expiresAt === undefined) return c.json({ error: 'mcp_token_invalid' }, 401);
    const authorization = c.req.raw.headers.get('authorization')!;
    const authInfo: McpAuthInfo = {
      token: authorization.slice('Bearer '.length),
      clientId: actor.api_client_id,
      scopes: actor.api_scopes,
      expiresAt,
      actor,
    };
    const parsedBody = await c.req.json().catch(() => null);
    if (parsedBody === null) return c.json({ error: 'malformed_request' }, 400);
    return handler.fetch(c.req.raw, { authInfo, parsedBody });
  };
}

export function buildDocumindMcpServer(state: AppState, actor: CurrentActor): McpServer {
  const server = new McpServer({ name: 'documind', version: '1.0.0' });
  if (actor.api_scopes.includes('chat:write')) {
    server.registerTool(
      'documind_chat',
      {
        description: 'Ask DocuMind using the same retrieval, citations, Agent, and knowledge-base permissions as product chat.',
        inputSchema: z.object({
          message: z.string().trim().min(1),
          conversation_id: z.string().uuid().optional(),
          kb_ids: z.array(z.string().uuid()).optional(),
          model_id: z.string().optional(),
          thinking_enabled: z.boolean().optional(),
        }),
      },
      async ({ message, conversation_id, kb_ids, model_id, thinking_enabled }) => {
        const result = await runChat(
          state, actor, message, conversation_id, kb_ids, model_id, thinking_enabled,
        );
        await recordAuditEvent(state.sql, actor, 'mcp.tool.documind_chat', 'conversation', result.conversation_id, {
          api_client_id: actor.api_client_id,
          message_id: result.message_id,
        });
        return {
          content: [{ type: 'text' as const, text: result.answer }],
          structuredContent: result,
        };
      },
    );
  }
  if (actor.api_scopes.includes('conversations:read')) {
    server.registerTool(
      'documind_conversation_list',
      {
        description: 'List conversations owned by this MCP application in its tenant.',
        inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      },
      async ({ limit }) => {
        const result = await state.repository.listSessions(actor.tenant_id, actor.user_id, limit, null);
        await recordAuditEvent(state.sql, actor, 'mcp.tool.documind_conversation_list', 'conversation', null, {
          api_client_id: actor.api_client_id,
          returned: result.items.length,
        });
        return toolJson(result);
      },
    );
    server.registerTool(
      'documind_conversation_get',
      {
        description: 'Read one conversation and its messages owned by this MCP application.',
        inputSchema: z.object({ conversation_id: z.string().uuid() }),
      },
      async ({ conversation_id }) => {
        const session = await ownedSession(state, actor, conversation_id);
        const messages = await state.repository.getMessages(actor.tenant_id, session.id);
        await recordAuditEvent(state.sql, actor, 'mcp.tool.documind_conversation_get', 'conversation', session.id, {
          api_client_id: actor.api_client_id,
        });
        return toolJson({ conversation: session, messages });
      },
    );
  }
  if (actor.api_scopes.includes('conversations:write')) {
    server.registerTool(
      'documind_conversation_rename',
      {
        description: 'Rename one conversation owned by this MCP application.',
        inputSchema: z.object({ conversation_id: z.string().uuid(), title: z.string().trim().min(1).max(200) }),
      },
      async ({ conversation_id, title }) => {
        await ownedSession(state, actor, conversation_id);
        const updated = await state.repository.updateSessionTitle(
          actor.tenant_id, actor.user_id, conversation_id, title, true,
        );
        if (!updated) throw AppError.conversationNotFound();
        await recordAuditEvent(state.sql, actor, 'mcp.tool.documind_conversation_rename', 'conversation', conversation_id, {
          api_client_id: actor.api_client_id,
        });
        return toolJson({ conversation_id, title });
      },
    );
    server.registerTool(
      'documind_conversation_delete',
      {
        description: 'Delete one conversation owned by this MCP application.',
        inputSchema: z.object({ conversation_id: z.string().uuid() }),
      },
      async ({ conversation_id }) => {
        const session = await ownedSession(state, actor, conversation_id);
        session.status = 'deleted';
        session.updated_at = nowRfc3339();
        await state.repository.updateSession(session);
        await recordAuditEvent(state.sql, actor, 'mcp.tool.documind_conversation_delete', 'conversation', conversation_id, {
          api_client_id: actor.api_client_id,
        });
        return toolJson({ conversation_id, status: 'deleted' });
      },
    );
  }
  return server;
}

async function runChat(
  state: AppState,
  actor: CurrentActor,
  message: string,
  conversationId?: string,
  requestedKbIds?: string[],
  modelId?: string,
  thinkingEnabled?: boolean,
) {
  requireScope(actor, 'chat:write');
  let session: ConversationSession;
  if (conversationId) {
    session = await ownedSession(state, actor, conversationId);
  } else {
    const allowed = requestedKbIds?.length
      ? requestedKbIds.filter((id) => actor.allowed_kb_ids.includes(id))
      : [...actor.allowed_kb_ids];
    if (requestedKbIds?.length && allowed.length !== requestedKbIds.length) {
      throw AppError.kbScopeDenied();
    }
    session = {
      id: newUuid(),
      tenant_id: actor.tenant_id,
      user_id: actor.user_id,
      title: [...message].slice(0, 48).join('') || '新会话',
      kb_ids: allowed,
      status: 'active',
      summary: null,
      created_at: nowRfc3339(),
      updated_at: nowRfc3339(),
    };
    await state.repository.createSession(session);
  }

  const bridge = new Hono<AppEnv>();
  bridge.use('*', async (c, next) => {
    c.set('appState', state);
    c.set('actor', actor);
    await next();
  });
  bridge.post('/conversations/:conversation_id/messages', sendMessageHandler);
  const response = await bridge.request(`/conversations/${session.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      content: message,
      kb_ids: requestedKbIds,
      model_id: modelId,
      thinking_enabled: thinkingEnabled,
      client_request_id: `mcp-${newUuid()}`,
    }),
  });
  if (!response.ok) {
    throw AppError.badRequest('MCP_CHAT_FAILED', await response.text());
  }
  await response.text();
  const messages = await state.repository.getMessages(actor.tenant_id, session.id);
  const assistant = [...messages].reverse().find((item) => item.role === 'assistant');
  if (!assistant || assistant.status === 'failed') {
    throw AppError.badRequest(
      assistant?.error_code ?? 'MCP_CHAT_FAILED',
      assistant?.error_message ?? 'DocuMind 对话未返回结果',
    );
  }
  const citations = await state.repository.getCitations(assistant.id);
  return {
    conversation_id: session.id,
    message_id: assistant.id,
    answer: assistant.content,
    confidence: assistant.confidence,
    citations,
  };
}

async function ownedSession(state: AppState, actor: CurrentActor, conversationId: string) {
  const session = await state.repository.getSession(actor.tenant_id, conversationId);
  if (session === null || session.user_id !== actor.user_id || session.status !== 'active') {
    throw AppError.conversationNotFound();
  }
  return session;
}

function toolJson(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: { result: value },
  };
}

function validOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
