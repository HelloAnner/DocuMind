// 移植自 apps/api-rs/src/api/admin_api_clients.rs
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Sql, TransactionSql } from 'postgres';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import { recordAuditEvent } from '../auth/audit.ts';
import { requirePermission, requireTenantAdmin } from '../auth/permissions.ts';
import { newUuid } from '../infra/uuid.ts';
import { toRfc3339 } from '../infra/time.ts';
import { generateToken, tokenHash, tokenPrefix } from './external_api.ts';
import {
  normalizeName, normalizeScopes, validateExpiration,
  type ClientSummary, type CreateClientRequest, type CreateTokenRequest,
  type CreatedClient, type CreatedToken, type TokenSummary, type UpdateClientRequest,
} from './admin_api_clients_model.ts';

export function adminApiClientsRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/admin/api-clients', listClients);
  router.post('/api/admin/api-clients', createClient);
  router.patch('/api/admin/api-clients/:client_id', updateClient);
  router.post('/api/admin/api-clients/:client_id/tokens', createToken);
  router.post('/api/admin/api-clients/:client_id/tokens/:token_id/revoke', revokeToken);
  return router;
}

async function listClients(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'api_client.read');
  const sql = state.sql;
  if (!sql) throw databaseRequired();

  const rows = await sql`
    SELECT id, name, description, scopes, status, rate_limit_per_minute, service_user_id, created_at
    FROM api_client WHERE tenant_id = ${actor.tenant_id} ORDER BY created_at DESC
  `;
  const clients: ClientSummary[] = [];
  for (const row of rows) {
    const clientId = String(row.id);
    const serviceUserId = String(row.service_user_id);
    const kbIds = await sql`
      SELECT kb_id FROM knowledge_base_acl
      WHERE tenant_id = ${actor.tenant_id} AND subject_type = 'user' AND subject_id = ${serviceUserId}
        AND permission IN ('read', 'write', 'manage') ORDER BY kb_id
    `;
    const tokenRows = await sql`
      SELECT id, token_prefix, status, expires_at, last_used_at, created_at
      FROM api_token WHERE client_id = ${clientId} ORDER BY created_at DESC
    `;
    clients.push({
      id: clientId,
      name: String(row.name),
      description: (row.description as string | null) ?? null,
      scopes: (row.scopes as string[]) ?? [],
      status: String(row.status),
      rate_limit_per_minute: Number(row.rate_limit_per_minute ?? 0),
      kb_ids: kbIds.map((kbRow) => String(kbRow.kb_id)),
      tokens: tokenRows.map(tokenSummary),
      created_at: toRfc3339(new Date(row.created_at as Date | string)),
    });
  }
  return c.json(clients);
}

async function createClient(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'api_client.write');
  const request = await c.req.json() as CreateClientRequest;
  const name = normalizeName(request.name);
  const scopes = normalizeScopes(request.scopes ?? []);
  const expiresInDays = request.expires_in_days ?? 90;
  validateExpiration(expiresInDays);
  const rateLimit = request.rate_limit_per_minute ?? 60;
  if (!(rateLimit >= 1 && rateLimit <= 10_000)) {
    throw AppError.badRequest('API_RATE_LIMIT_INVALID', '每分钟限额必须在 1 到 10000 之间');
  }
  const sql = state.sql;
  if (!sql) throw databaseRequired();
  const kbIds = request.kb_ids ?? [];
  await ensureKbs(sql, actor.tenant_id, kbIds);

  const clientId = newUuid();
  const serviceUserId = newUuid();
  const tokenId = newUuid();
  const secret = generateToken(tokenId);
  const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);
  const description = (request.description ?? '').trim().length > 0
    ? request.description!.trim() : null;
  const loginId = `api-${serviceUserId}@internal.documind`;

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO app_user (id, login_id, email, name, auth_provider, status)
      VALUES (${serviceUserId}, ${loginId}, ${loginId}, ${name}, 'api', 'active')
    `;
    await tx`
      INSERT INTO tenant_member (tenant_id, user_id, roles, status, joined_at)
      VALUES (${actor.tenant_id}, ${serviceUserId}, ARRAY['end_user'], 'active', NOW())
    `;
    await tx`
      INSERT INTO api_client
        (id, tenant_id, service_user_id, name, description, scopes, rate_limit_per_minute, created_by)
      VALUES (${clientId}, ${actor.tenant_id}, ${serviceUserId}, ${name}, ${description}, ${scopes}, ${rateLimit}, ${actor.user_id})
    `;
    for (const kbId of kbIds) {
      await tx`
        INSERT INTO knowledge_base_acl
          (tenant_id, kb_id, subject_type, subject_id, permission, created_by)
        VALUES (${actor.tenant_id}, ${kbId}, 'user', ${serviceUserId}, 'read', ${actor.user_id})
        ON CONFLICT DO NOTHING
      `;
    }
    await insertToken(tx, tokenId, clientId, secret, expiresAt, actor.user_id);
  });

  await recordAuditEvent(sql, actor, 'api_client.create', 'api_client', clientId, {
    name, scopes, kb_ids: kbIds, token_prefix: tokenPrefix(secret),
  });
  const client = await fetchClient(sql, actor.tenant_id, clientId);
  return c.json({ client, token: secret } satisfies CreatedClient);
}

async function createToken(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'api_client.write');
  const request = await c.req.json() as CreateTokenRequest;
  const expiresInDays = request.expires_in_days ?? 90;
  validateExpiration(expiresInDays);
  const sql = state.sql;
  if (!sql) throw databaseRequired();
  const clientId = c.req.param('client_id')!;
  await ensureClient(sql, actor.tenant_id, clientId);

  const tokenId = newUuid();
  const secret = generateToken(tokenId);
  const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);
  await sql.begin(async (tx) => {
    await insertToken(tx, tokenId, clientId, secret, expiresAt, actor.user_id);
  });
  await recordAuditEvent(sql, actor, 'api_token.create', 'api_token', tokenId, {
    client_id: clientId, token_prefix: tokenPrefix(secret), expires_at: toRfc3339(expiresAt),
  });
  const token: TokenSummary = {
    id: tokenId,
    token_prefix: tokenPrefix(secret),
    status: 'active',
    expires_at: toRfc3339(expiresAt),
    last_used_at: null,
    created_at: toRfc3339(new Date()),
  };
  return c.json({ token, secret } satisfies CreatedToken);
}

async function revokeToken(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'api_client.revoke');
  const sql = state.sql;
  if (!sql) throw databaseRequired();
  const clientId = c.req.param('client_id')!;
  const tokenId = c.req.param('token_id')!;

  const result = await sql`
    UPDATE api_token tok SET status = 'revoked', revoked_at = NOW(), revoked_by = ${actor.user_id}
    FROM api_client client
    WHERE tok.id = ${tokenId} AND tok.client_id = ${clientId} AND client.id = tok.client_id
      AND client.tenant_id = ${actor.tenant_id} AND tok.status = 'active'
  `;
  if (result.count === 0) throw tokenNotFound();
  await recordAuditEvent(sql, actor, 'api_token.revoke', 'api_token', tokenId, {
    client_id: clientId,
  });
  return c.json({ id: tokenId, status: 'revoked' });
}

async function updateClient(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'api_client.write');
  const request = await c.req.json() as UpdateClientRequest;
  if (request.status !== 'active' && request.status !== 'disabled') {
    throw AppError.badRequest('API_CLIENT_STATUS_INVALID', '状态只能是 active 或 disabled');
  }
  const sql = state.sql;
  if (!sql) throw databaseRequired();
  const clientId = c.req.param('client_id')!;

  const result = await sql`
    UPDATE api_client SET status = ${request.status}, updated_at = NOW()
    WHERE id = ${clientId} AND tenant_id = ${actor.tenant_id}
  `;
  if (result.count === 0) throw clientNotFound();
  await recordAuditEvent(sql, actor, 'api_client.status_update', 'api_client', clientId, {
    status: request.status,
  });
  return c.json(await fetchClient(sql, actor.tenant_id, clientId));
}

async function insertToken(
  tx: TransactionSql, tokenId: string, clientId: string, secret: string,
  expiresAt: Date, createdBy: string,
): Promise<void> {
  await tx`
    INSERT INTO api_token
      (id, client_id, token_prefix, secret_hash, expires_at, created_by)
    VALUES (${tokenId}, ${clientId}, ${tokenPrefix(secret)}, ${tokenHash(secret)}, ${expiresAt}, ${createdBy})
  `;
}

async function fetchClient(sql: Sql, tenantId: string, clientId: string): Promise<ClientSummary> {
  const rows = await sql`
    SELECT id, name, description, scopes, status, rate_limit_per_minute, service_user_id, created_at
    FROM api_client WHERE tenant_id = ${tenantId} AND id = ${clientId}
  `;
  const row = rows[0];
  if (!row) throw clientNotFound();
  const serviceUserId = String(row.service_user_id);
  const kbRows = await sql`
    SELECT kb_id FROM knowledge_base_acl
    WHERE tenant_id = ${tenantId} AND subject_type = 'user' AND subject_id = ${serviceUserId} ORDER BY kb_id
  `;
  const tokenRows = await sql`
    SELECT id, token_prefix, status, expires_at, last_used_at, created_at
    FROM api_token WHERE client_id = ${clientId} ORDER BY created_at DESC
  `;
  return {
    id: String(row.id),
    name: String(row.name),
    description: (row.description as string | null) ?? null,
    scopes: (row.scopes as string[]) ?? [],
    status: String(row.status),
    rate_limit_per_minute: Number(row.rate_limit_per_minute ?? 0),
    kb_ids: kbRows.map((kbRow) => String(kbRow.kb_id)),
    tokens: tokenRows.map(tokenSummary),
    created_at: toRfc3339(new Date(row.created_at as Date | string)),
  };
}

function tokenSummary(row: Record<string, unknown>): TokenSummary {
  const lastUsedAt = row.last_used_at as Date | string | null;
  return {
    id: String(row.id),
    token_prefix: String(row.token_prefix),
    status: String(row.status),
    expires_at: toRfc3339(new Date(row.expires_at as Date | string)),
    last_used_at: lastUsedAt === null || lastUsedAt === undefined
      ? null : toRfc3339(new Date(lastUsedAt)),
    created_at: toRfc3339(new Date(row.created_at as Date | string)),
  };
}

async function ensureClient(sql: Sql, tenantId: string, clientId: string): Promise<void> {
  const rows = await sql`
    SELECT EXISTS(SELECT 1 FROM api_client WHERE tenant_id = ${tenantId} AND id = ${clientId}) AS exists
  `;
  if (!rows[0]?.exists) throw clientNotFound();
}

async function ensureKbs(sql: Sql, tenantId: string, kbIds: string[]): Promise<void> {
  if (kbIds.length === 0) {
    throw AppError.badRequest('API_CLIENT_KB_REQUIRED', '请至少授权一个知识库');
  }
  const rows = await sql`
    SELECT COUNT(DISTINCT id) AS count FROM knowledge_base
    WHERE tenant_id = ${tenantId} AND id = ANY(${kbIds}) AND status = 'active'
  `;
  if (Number(rows[0]?.count ?? 0) !== new Set(kbIds).size) {
    throw AppError.kbScopeDenied();
  }
}

function databaseRequired(): AppError {
  return AppError.badRequest('DATABASE_REQUIRED', 'API 接入管理需要 PostgreSQL');
}
function clientNotFound(): AppError {
  return AppError.notFound('API_CLIENT_NOT_FOUND', 'API Client 不存在');
}
function tokenNotFound(): AppError {
  return AppError.notFound('API_TOKEN_NOT_FOUND', 'API Token 不存在或已吊销');
}
