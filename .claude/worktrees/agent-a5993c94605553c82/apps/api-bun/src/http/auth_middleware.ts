// 移植自 apps/api-rs/src/auth.rs 的 ActorExtractor
import { createMiddleware } from 'hono/factory';
import { AppError } from '../errors.ts';
import { actorFromClaims } from '../auth/actor.ts';
import { claimsFromAuthorizationHeader } from '../auth/jwt.ts';
import { validateAndRenewAuthSession } from '../auth/session.ts';
import { actorFromApiHeaders } from '../api/external_api.ts';
import type { AppEnv } from './types.ts';

/** 依赖注入端口：state 未完全就绪时便于测试。 */
export interface ActorResolutionDeps {
  config: import('../config.ts').AppConfig;
  sql: import('postgres').Sql | null;
  redis: import('ioredis').Redis | null;
  dbPoolPresent: boolean;
}

export function extractActorMiddleware(depsFor: (c: import('hono').Context<AppEnv>) => ActorResolutionDeps & { state: import('../state.ts').AppState }) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const { state, ...deps } = depsFor(c);
    const headers = c.req.raw.headers;
    const actor = await resolveActor(state, deps, headers);
    c.set('actor', actor);
    await next();
  });
}

export async function resolveActor(
  state: import('../state.ts').AppState,
  deps: ActorResolutionDeps,
  headers: Headers,
): Promise<import('../models/identity.ts').CurrentActor> {
  const { config } = deps;
  // 1. 优先 JWT Bearer
  const authorization = headers.get('authorization');
  if (authorization && authorization.startsWith('Bearer ')) {
    const claims = await claimsFromAuthorizationHeader(config, authorization);
    if (claims.sid !== null) {
      await validateAndRenewAuthSession(deps.redis, config, claims);
    }
    return actorFromClaims({ sql: deps.sql, config }, claims);
  }
  // external API（API client/token）身份
  const apiActor = await actorFromApiHeaders(state, headers);
  if (apiActor) return apiActor;

  // 2. 有数据库时必须有本地 JWT/session 身份
  if (deps.dbPoolPresent) throw AppError.unauthorized();

  // 3. 无 DB 开发模式：信任上游 header
  const tenantId = parseUuidHeader(headers.get('x-tenant-id')) ?? config.defaultTenantId;
  const userId = parseUuidHeader(headers.get('x-user-id')) ?? config.defaultUserId;
  const requestedRole = headers.get('x-role') ?? config.defaultRole;
  return {
    user_id: userId, tenant_id: tenantId, login_id: requestedRole, email: '', name: requestedRole,
    scope: requestedRole === 'super_admin' ? 'platform' : 'tenant',
    roles: requestedRole === 'super_admin' ? ['super_admin'] : [requestedRole],
    permissions: [], allowed_kb_ids: config.defaultKbIds,
    is_super_admin: requestedRole === 'super_admin',
    api_client_id: null, api_token_id: null, api_scopes: [], api_token_expires_at: null,
  };
}

function parseUuidHeader(value: string | null): string | null {
  if (!value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}
