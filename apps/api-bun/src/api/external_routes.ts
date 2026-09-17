// 移植自 apps/api-rs/src/api/external_api.rs 的 router() —— 外部开放 API
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import { toRfc3339 } from '../infra/time.ts';
import type { CurrentActor } from '../models/identity.ts';
import { actorFromApiHeaders, requireScope } from './external_api.ts';
import {
  createConversationHandler, getConversationHandler, getMessageTracesHandler,
  getMessagesHandler, listConversationsHandler, sendMessageHandler,
} from './conversations.ts';

interface ApiIdentity {
  client_id: string;
  client_name: string;
  tenant_id: string;
  scopes: string[];
  allowed_kb_ids: string[];
  token_expires_at: string;
}

export function externalApiRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  // 对齐 Rust 的 .route_layer(require_api_token_header)：整组路由都要求 Bearer dm_live_
  router.use('/api/v1/external/*', requireApiTokenHeader);
  router.get('/api/v1/external/me', meHandler);
  router.get('/api/v1/external/knowledge-bases', listKnowledgeBasesHandler);
  router.post('/api/v1/external/conversations', createConversationHandler);
  router.get('/api/v1/external/conversations', listConversationsHandler);
  router.get('/api/v1/external/conversations/:conversation_id', getConversationHandler);
  router.get(
    '/api/v1/external/conversations/:conversation_id/messages', getMessagesHandler);
  router.post(
    '/api/v1/external/conversations/:conversation_id/messages', sendMessageHandler);
  router.get(
    '/api/v1/external/conversations/:conversation_id/messages/:message_id/traces',
    getMessageTracesHandler);
  return router;
}

/** 对应 Rust require_api_token_header + ApiActorExtractor。 */
export const requireApiTokenHeader = createMiddleware<AppEnv>(async (c, next) => {
  const authorization = c.req.raw.headers.get('authorization');
  const token = authorization !== null && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : null;
  if (token === null || !token.startsWith('dm_live_')) throw apiTokenInvalid();
  // 全局 actor 中间件已在 /api/* 下解析过同一个 API Token：直接复用，
  // 避免重复扣减速率限制与刷新 last_used_at；/documind 前缀下则在此解析。
  const existing: CurrentActor | undefined = c.get('actor');
  const actor = existing !== undefined && existing.api_client_id !== null
    ? existing
    : await actorFromApiHeaders(c.get('appState'), c.req.raw.headers);
  if (actor === null) throw apiTokenInvalid();
  c.set('actor', actor);
  await next();
});

async function meHandler(c: Context<AppEnv>): Promise<Response> {
  const actor = c.get('actor');
  const clientId = actor.api_client_id;
  if (clientId === null) throw apiTokenInvalid();
  const tokenExpiresAt = actor.api_token_expires_at;
  if (tokenExpiresAt === null) throw apiTokenInvalid();
  const body: ApiIdentity = {
    client_id: clientId,
    client_name: actor.name,
    tenant_id: actor.tenant_id,
    scopes: actor.api_scopes,
    allowed_kb_ids: actor.allowed_kb_ids,
    token_expires_at: tokenExpiresAt,
  };
  return c.json(body);
}

async function listKnowledgeBasesHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireScope(actor, 'knowledge_bases:read');
  const sql = state.sql;
  if (sql === null) throw apiDatabaseRequired();
  const rows = await sql`
    SELECT id, name, description, status, tags, updated_at
    FROM knowledge_base
    WHERE tenant_id = ${actor.tenant_id}
      AND id = ANY(${actor.allowed_kb_ids})
      AND status = 'active'
    ORDER BY name
  `;
  return c.json(rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    description: row.description === null || row.description === undefined
      ? null
      : String(row.description),
    status: String(row.status),
    tags: (row.tags as string[] | null) ?? [],
    updated_at: toRfc3339(new Date(row.updated_at as Date | string)),
  })));
}

function apiTokenInvalid(): AppError {
  return AppError.unauthorizedWith('INVALID_API_TOKEN', 'API Token 无效');
}

function apiDatabaseRequired(): AppError {
  return AppError.badRequest('DATABASE_REQUIRED', '外部 API 需要 PostgreSQL');
}
