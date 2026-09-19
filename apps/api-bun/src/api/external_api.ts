// 移植自 apps/api-rs/src/api/external_api.rs
import { AppError } from '../errors.ts';
import type { CurrentActor } from '../models/identity.ts';
import type { AppState } from '../state.ts';
import { resolveActorFromDb } from '../auth/actor.ts';
import { newUuid } from '../infra/uuid.ts';
import { toRfc3339 } from '../infra/time.ts';

export const DEFAULT_SCOPES = [
  'knowledge_bases:read',
  'chat:write',
  'conversations:read',
  'conversations:write',
];

export async function actorFromApiHeaders(
  state: AppState, headers: Headers,
): Promise<CurrentActor | null> {
  const authorization = headers.get('authorization');
  if (!authorization || !authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length);
  if (!token.startsWith('dm_live_')) return null;

  const tokenId = parseTokenId(token);
  if (!tokenId) throw apiTokenInvalid();
  const sql = state.sql;
  if (!sql) throw apiDatabaseRequired();
  const rows = await sql`
    SELECT tok.secret_hash, tok.status AS token_status, tok.expires_at,
           client.id AS client_id, client.name AS client_name,
           client.tenant_id, client.service_user_id, client.scopes,
           client.status AS client_status, client.rate_limit_per_minute
    FROM api_token tok
    JOIN api_client client ON client.id = tok.client_id
    JOIN tenant t ON t.id = client.tenant_id
    WHERE tok.id = ${tokenId} AND t.status = 'active'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw apiTokenInvalid();

  const tokenStatus = String(row.token_status);
  const clientStatus = String(row.client_status);
  const expiresAt = new Date(row.expires_at as Date | string);
  if (tokenStatus !== 'active') {
    throw AppError.unauthorizedWith('API_TOKEN_REVOKED', 'API Token 已被吊销');
  }
  if (clientStatus !== 'active') {
    throw AppError.unauthorizedWith('API_CLIENT_DISABLED', 'API 接入已被停用');
  }
  if (expiresAt.getTime() <= Date.now()) {
    throw AppError.unauthorizedWith('API_TOKEN_EXPIRED', 'API Token 已过期');
  }
  const expected = String(row.secret_hash);
  if (!constantTimeEq(expected, tokenHash(token))) throw apiTokenInvalid();

  await enforceRateLimit(state, tokenId, Number(row.rate_limit_per_minute ?? 0));

  const tenantId = String(row.tenant_id);
  const serviceUserId = String(row.service_user_id);
  const actor = await resolveActorFromDb(sql, tenantId, serviceUserId, 'end_user', 'tenant');
  const scopes = (row.scopes as string[]) ?? [];
  actor.permissions = actor.permissions.filter((permission) => permissionAllowed(scopes, permission));
  const kbRows = await sql`
    SELECT kb_id FROM knowledge_base_acl
    WHERE tenant_id = ${tenantId} AND subject_type = 'user' AND subject_id = ${serviceUserId}
      AND permission IN ('read', 'write', 'manage')
  `;
  actor.allowed_kb_ids = kbRows.map((kbRow) => String(kbRow.kb_id));
  actor.api_client_id = String(row.client_id);
  actor.api_token_id = tokenId;
  actor.api_scopes = scopes;
  actor.api_token_expires_at = toRfc3339(expiresAt);
  actor.name = String(row.client_name);

  await sql`UPDATE api_token SET last_used_at = NOW() WHERE id = ${tokenId}`;
  return actor;
}

export function requireScope(actor: CurrentActor, scope: string): void {
  if (!actor.api_scopes.includes(scope)) {
    throw AppError.forbiddenWith('API_SCOPE_DENIED', `API Client 缺少 ${scope} 权限`);
  }
}

export function generateToken(tokenId: string): string {
  return `dm_live_${tokenId}_${newUuid().replace(/-/g, '')}${newUuid().replace(/-/g, '')}`;
}

export function tokenHash(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex');
}

export function tokenPrefix(token: string): string {
  return [...token].slice(0, 24).join('');
}

export function parseTokenId(token: string): string | null {
  if (!token.startsWith('dm_live_')) return null;
  const rest = token.slice('dm_live_'.length);
  const candidate = rest.slice(0, 36);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate : null;
}

function permissionAllowed(scopes: string[], permission: string): boolean {
  switch (permission) {
    case 'kb.read':
      return scopes.some((scope) => scope === 'knowledge_bases:read' || scope === 'chat:write');
    case 'chat.ask': case 'answer.feedback':
      return scopes.includes('chat:write');
    default:
      return false;
  }
}

async function enforceRateLimit(state: AppState, tokenId: string, limit: number): Promise<void> {
  const redis = state.redis;
  if (!redis) return;
  const minute = Math.floor(Date.now() / 1000 / 60);
  const key = `documind:external-rate:${tokenId}:${minute}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 120);
  if (count > limit) {
    throw AppError.rateLimited('API_RATE_LIMITED', 'API 请求超过当前分钟限额');
  }
}

export function constantTimeEq(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= (a[index]! ^ b[index]!);
  return diff === 0;
}

function apiTokenInvalid(): AppError {
  return AppError.unauthorizedWith('INVALID_API_TOKEN', 'API Token 无效');
}
function apiDatabaseRequired(): AppError {
  return AppError.badRequest('DATABASE_REQUIRED', '外部 API 需要 PostgreSQL');
}
