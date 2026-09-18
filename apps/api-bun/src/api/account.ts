// 移植自 apps/api-rs/src/api/account.rs
import { Hono } from 'hono';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import { actorFromClaims } from '../auth/actor.ts';
import { recordAuditEvent } from '../auth/audit.ts';
import { meResponse } from './auth.ts';

interface UpdateProfileRequest { name: string; avatar_url?: string | null; }

export function accountRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/account/profile', profileHandler);
  router.patch('/api/account/profile', updateProfileHandler);
  return router;
}

async function profileHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  return c.json(await meResponse(state, c.get('actor')));
}

async function updateProfileHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  const req = await c.req.json() as UpdateProfileRequest;
  const name = (req.name ?? '').trim();
  if (name.length === 0 || [...name].length > 128) {
    throw AppError.badRequest('PROFILE_NAME_INVALID', '姓名不能为空且不能超过 128 个字符');
  }
  const avatarUrl = (req.avatar_url ?? '').trim().length > 0 ? req.avatar_url!.trim() : null;
  if (avatarUrl !== null && [...avatarUrl].length > 2048) {
    throw AppError.badRequest('PROFILE_AVATAR_URL_INVALID', '头像地址不能超过 2048 个字符');
  }
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '个人资料功能需要数据库');
  await sql`
    UPDATE app_user SET name = ${name}, avatar_url = ${avatarUrl}, updated_at = NOW() WHERE id = ${actor.user_id}
  `;
  const refreshed = await actorFromClaims({ sql, config: state.config }, {
    sub: actor.user_id, email: actor.email, role: actor.roles[0] ?? 'end_user',
    scope: actor.scope, tenant_id: actor.tenant_id, sid: null,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  await recordAuditEvent(sql, refreshed, 'account.profile.update', 'app_user',
    refreshed.user_id, { name, avatar_configured: avatarUrl !== null });
  return c.json(await meResponse(state, refreshed));
}

