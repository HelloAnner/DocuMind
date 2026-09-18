// 移植自 apps/api-rs/src/auth.rs 的 Claims / issue_token / claims_from_headers
import { SignJWT, jwtVerify } from 'jose';
import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import { nowSeconds } from '../infra/time.ts';
import type { CurrentActor } from '../models/identity.ts';

export interface Claims {
  sub: string; email: string; role: string; scope: string;
  tenant_id: string | null; sid: string | null; exp: number;
}

export async function issueToken(
  config: AppConfig, actor: CurrentActor, sessionId: string | null,
): Promise<string> {
  const exp = nowSeconds() + Math.max(1, config.authTokenExpireHours) * 3600;
  const role = actor.roles[0] ?? 'user';
  const claims: Record<string, unknown> = {
    sub: actor.user_id, email: actor.email, role, scope: actor.scope,
    tenant_id: actor.tenant_id, exp,
  };
  if (sessionId !== null) claims.sid = sessionId;
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
    tenant_id: null, sid: sessionId, exp,
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
    return {
      sub: String(payload.sub), email: String(payload.email ?? ''),
      role: String(payload.role ?? ''), scope: String(payload.scope ?? ''),
      tenant_id: payload.tenant_id == null ? null : String(payload.tenant_id),
      sid: (payload.sid as string | undefined) ?? null,
      exp: Number(payload.exp ?? 0),
    };
  } catch {
    throw AppError.unauthorized();
  }
}
