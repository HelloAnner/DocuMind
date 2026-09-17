// 移植自 apps/api-rs/src/api/account.rs
import { Hono } from 'hono';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import { actorFromClaims } from '../auth/actor.ts';
import { createAuthSession } from '../auth/session.ts';
import { issueToken } from '../auth/jwt.ts';
import { recordAuditEvent } from '../auth/audit.ts';
import { meResponse } from './auth.ts';
import type { LoginResponse } from './auth_types.ts';

interface UpdateProfileRequest { name: string; avatar_url?: string | null; }
interface SwitchTenantRequest { tenant_id: string; }
interface AccountTenantSummary {
  id: string; name: string; slug: string; status: string;
  roles: string[]; current: boolean;
}

export function accountRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/account/profile', profileHandler);
  router.patch('/api/account/profile', updateProfileHandler);
  router.get('/api/account/tenants', listAccountTenantsHandler);
  router.post('/api/account/switch-tenant', switchTenantHandler);
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

async function listAccountTenantsHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  if (actor.is_super_admin) return c.json([]);
  const sql = state.sql;
  if (!sql) {
    return c.json([{
      id: actor.tenant_id, name: state.config.defaultTenantName,
      slug: state.config.defaultTenantSlug, status: 'active',
      roles: actor.roles, current: true,
    } satisfies AccountTenantSummary]);
  }
  const rows = await sql`
    SELECT t.id, t.name, t.slug, t.status, tm.roles
    FROM tenant_member tm
    JOIN tenant t ON t.id = tm.tenant_id
    WHERE tm.user_id = ${actor.user_id}
      AND tm.status = 'active'
      AND t.status = 'active'
      AND NOT ('super_admin' = ANY(tm.roles))
    ORDER BY t.name ASC
  `;
  return c.json(rows.map((row) => {
    const id = String(row.id);
    return {
      id, name: String(row.name), slug: String(row.slug), status: String(row.status),
      roles: (row.roles as string[]) ?? [], current: id === actor.tenant_id,
    } satisfies AccountTenantSummary;
  }));
}

async function switchTenantHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  const req = await c.req.json() as SwitchTenantRequest;
  if (actor.is_super_admin) {
    throw AppError.forbiddenWith(
      'PLATFORM_ADMIN_TENANT_SWITCH_FORBIDDEN', '平台管理员不能进入租户数据空间');
  }
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '租户切换功能需要数据库');
  const membership = await sql`
    SELECT EXISTS(
      SELECT 1
      FROM tenant_member tm
      JOIN tenant t ON t.id = tm.tenant_id
      WHERE tm.user_id = ${actor.user_id}
        AND tm.tenant_id = ${req.tenant_id}
        AND tm.status = 'active'
        AND t.status = 'active'
        AND NOT ('super_admin' = ANY(tm.roles))
    ) AS exists
  `;
  if (!membership[0]?.exists) {
    throw AppError.forbiddenWith(
      'TENANT_MEMBERSHIP_NOT_FOUND', '当前账号不属于该租户或租户不可用');
  }
  await sql`
    UPDATE app_user SET last_active_tenant = ${req.tenant_id}, updated_at = NOW() WHERE id = ${actor.user_id}
  `;
  const switched = await actorFromClaims({ sql, config: state.config }, {
    sub: actor.user_id, email: actor.email, role: 'end_user', scope: 'tenant',
    tenant_id: req.tenant_id, sid: null, exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const sessionId = await createAuthSession(state.redis, state.config, switched);
  const accessToken = await issueToken(state.config, switched, sessionId);
  await recordAuditEvent(sql, switched, 'account.tenant.switch', 'tenant',
    req.tenant_id, { previous_tenant_id: actor.tenant_id });
  const me = await meResponse(state, switched);
  const body: LoginResponse = {
    access_token: accessToken, token_type: 'bearer', scope: me.scope,
    user: me.user, tenant: me.tenant, roles: me.roles,
    permissions: me.permissions, allowed_kb_ids: me.allowed_kb_ids,
  };
  return c.json(body);
}
