// 移植自 apps/api-rs/src/auth.rs 的 Claims / issue_token / claims_from_headers
import { SignJWT, jwtVerify } from 'jose';
import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import { nowSeconds } from '../infra/time.ts';
import type { CurrentActor } from '../models/identity.ts';

export interface Claims {
  sub: string; email: string; role: string; scope: string;
  tenant_id: string | null; sid: string | null; exp: number;
  auth_source?: 'local' | 'portal';
  portal_permissions?: string[];
}

export async function issueToken(
  config: AppConfig, actor: CurrentActor, sessionId: string | null,
  portalPermissions?: string[],
): Promise<string> {
  const exp = nowSeconds() + Math.max(1, config.authTokenExpireHours) * 3600;
  const role = actor.roles[0] ?? 'user';
  const claims: Record<string, unknown> = {
    sub: actor.user_id, email: actor.email, role, scope: actor.scope,
    tenant_id: actor.tenant_id, exp,
  };
  if (sessionId !== null) claims.sid = sessionId;
  claims.auth_source = portalPermissions === undefined ? 'local' : 'portal';
  if (portalPermissions !== undefined) claims.portal_permissions = portalPermissions;
  const key = new TextEncoder().encode(config.jwtSecret);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(key);
}

export async function issueIdentityToken(
  config: AppConfig,
  identity: { user_id: string; email: string },
  sessionId: string,
): Promise<string> {
  const exp = nowSeconds() + Math.max(1, config.authTokenExpireHours) * 3600;
  const key = new TextEncoder().encode(config.jwtSecret);
  return new SignJWT({
    sub: identity.user_id, email: identity.email, role: '', scope: 'tenant',
    tenant_id: null, sid: sessionId, exp, auth_source: 'local',
  }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(key);
}

export async function claimsFromAuthorizationHeader(
  config: AppConfig, authorization: string | null,
): Promise<Claims> {
  if (!authorization || !authorization.startsWith('Bearer ')) throw AppError.unauthorized();
  const token = authorization.slice('Bearer '.length);
  try {
    const key = new TextEncoder().encode(config.jwtSecret);
    const { payload } = await jwtVerify(token, key);
    if (payload.auth_source !== undefined && payload.auth_source !== 'local'
      && payload.auth_source !== 'portal') throw AppError.unauthorized();
    if (payload.auth_source === 'portal'
      && (!Array.isArray(payload.portal_permissions)
        || !payload.portal_permissions.every((value) => typeof value === 'string'))) {
      throw AppError.unauthorized();
    }
    return {
      sub: String(payload.sub), email: String(payload.email ?? ''),
      role: String(payload.role ?? ''), scope: String(payload.scope ?? ''),
      tenant_id: payload.tenant_id == null ? null : String(payload.tenant_id),
      sid: (payload.sid as string | undefined) ?? null,
      exp: Number(payload.exp ?? 0),
      auth_source: payload.auth_source as Claims['auth_source'],
      portal_permissions: payload.auth_source === 'portal' ? payload.portal_permissions as string[] : undefined,
    };
  } catch {
    throw AppError.unauthorized();
  }
}
