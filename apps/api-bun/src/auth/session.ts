// 移植自 apps/api-rs/src/auth.rs 的 AuthSession / create / validate_and_renew / delete
import type Redis from 'ioredis';
import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import { nowSeconds } from '../infra/time.ts';
import type { CurrentActor } from '../models/identity.ts';
import type { Claims } from './jwt.ts';

interface AuthSession {
  user_id: string; tenant_id: string; role: string; scope: string;
  created_at: number; last_seen_at: number;
}

function authSessionKey(sessionId: string): string {
  return `documind:auth:session:${sessionId}`;
}

export async function createAuthSession(
  redis: Redis | null, config: AppConfig, actor: CurrentActor,
): Promise<string> {
  const sessionId = crypto.randomUUID();
  if (!redis) return sessionId;
  const now = nowSeconds();
  const session: AuthSession = {
    user_id: actor.user_id, tenant_id: actor.tenant_id,
    role: actor.roles[0] ?? 'user', scope: actor.scope,
    created_at: now, last_seen_at: now,
  };
  await redis.set(
    authSessionKey(sessionId), JSON.stringify(session), 'EX',
    Math.max(1, config.authTokenExpireHours) * 3600,
  );
  return sessionId;
}

export async function validateAndRenewAuthSession(
  redis: Redis | null, config: AppConfig, claims: Claims,
): Promise<void> {
  if (!redis) return;
  const sessionId = claims.sid;
  if (!sessionId) throw AppError.unauthorized();
  const raw = await redis.get(authSessionKey(sessionId));
  if (!raw) throw AppError.unauthorized();
  let session: AuthSession;
  try {
    session = JSON.parse(raw) as AuthSession;
  } catch {
    throw AppError.unauthorized();
  }
  if (session.user_id !== claims.sub || session.tenant_id !== claims.tenant_id
    || session.role !== claims.role || session.scope !== claims.scope) {
    throw AppError.unauthorized();
  }
  session.last_seen_at = nowSeconds();
  await redis.set(
    authSessionKey(sessionId), JSON.stringify(session), 'EX',
    Math.max(1, config.authTokenExpireHours) * 3600,
  );
}

export async function deleteAuthSession(redis: Redis | null, sessionId: string): Promise<void> {
  if (!redis) return;
  await redis.del(authSessionKey(sessionId));
}
