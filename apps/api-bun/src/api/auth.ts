// 移植自 apps/api-rs/src/api/auth.rs
import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import type { Sql } from 'postgres';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import type { AppState } from '../state.ts';
import { authenticate, actorFromClaims } from '../auth/actor.ts';
import {
  claimsFromAuthorizationHeader, issueIdentityToken, issueToken, type Claims,
} from '../auth/jwt.ts';
import {
  createAuthSession, createIdentitySession, deleteAuthSession, setAuthSessionTenant,
  validateAndRenewAuthSession,
} from '../auth/session.ts';
import { recordAuditEvent } from '../auth/audit.ts';
import { derivePermissions, roleMatrix } from '../auth/permissions.ts';
import type { CurrentActor, MeResponse, TenantProfile, UserProfile } from '../models/identity.ts';
import type { LoginResponse } from './auth_types.ts';
import { newUuid } from '../infra/uuid.ts';

const AUTHENTICATED_HOME_PATH = '/chat';

interface LoginRequest {
  username?: string | null; email?: string | null; password: string;
  tenant_id?: string | null; tenant_slug?: string | null;
}
interface RegisterRequest { username: string; password: string; }
interface AcceptInvitationRequest {
  token: string; login_id?: string | null; name?: string | null; password?: string | null;
}
interface InvitationGrantStored { kb_id: string; permission: string; }

export function authRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/auth/portal/callback', portalCallbackHandler);
  router.get('/api/me', getMeHandler);
  router.post('/api/auth/login', loginHandler);
  router.post('/api/auth/refresh', refreshHandler);
  router.post('/api/auth/logout', logoutHandler);
  router.post('/api/invitations/accept', acceptInvitationHandler);
  router.get('/api/v1/me', getMeHandler);
  router.get('/api/v1/auth/me', getMeHandler);
  router.post('/api/v1/auth/register', registerHandler);
  router.post('/api/v1/auth/login', loginHandler);
  router.get('/api/v1/auth/tenants', authTenantsHandler);
  router.post('/api/v1/auth/switch-tenant', switchTenantHandler);
  router.post('/api/v1/tenants', createTenantHandler);
  router.post('/api/v1/auth/refresh', refreshHandler);
  router.post('/api/v1/auth/logout', logoutHandler);
  router.post('/api/v1/invitations/accept', acceptInvitationHandler);
  router.get('/api/v1/permission/me', permissionMeHandler);
  router.get('/api/v1/permission/matrix', permissionMatrixHandler);
  return router;
}

// ---------- portal ----------

interface PortalCallbackQuery { code: string; }
interface PortalContext {
  user_id: string; username: string; display_name: string; email?: string | null;
  tenant_id: string; tenant_code?: string | null; tenant_name?: string | null;
  system_code: string; portal_roles?: string[]; system_roles?: string[];
  permissions?: string[]; expires_at: number;
}

async function portalCallbackHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  try {
    const query = c.req.query() as unknown as PortalCallbackQuery;
    return await portalCallbackInner(state, query);
  } catch (error) {
    const appError = error instanceof AppError ? error : AppError.internal((error as Error).message);
    await recordAuditEvent(state.sql, null, 'portal.login.failure', 'auth_session', null, {
      failure_reason: portalErrorCode(appError),
    }).catch(() => undefined);
    return portalCallbackError(appError);
  }
}

async function portalCallbackInner(state: AppState, query: PortalCallbackQuery): Promise<Response> {
  if (state.config.authLoginMode !== 'portal') throw AppError.unauthorized();
  const portal = await exchangePortalTicket(state, query.code);
  if (portal.system_code !== 'documind' || portal.expires_at < Math.floor(Date.now() / 1000)) {
    throw AppError.unauthorized();
  }
  const roles = mapDocumindRoles(portal);
  const provisioned = await provisionPortalActor(state, portal, roles);
  const sessionId = await createAuthSession(state.redis, state.config, provisioned.actor);
  const token = await issueToken(state.config, provisioned.actor, sessionId);
  const identityAction = provisioned.identity_created
    ? 'portal.identity.link.created' : 'portal.identity.link.updated';
  const detail = {
    portal_user_id: portal.user_id, portal_tenant_id: portal.tenant_id,
    local_user_id: provisioned.actor.user_id, local_tenant_id: provisioned.actor.tenant_id,
    system_roles: portal.system_roles ?? [], portal_roles: portal.portal_roles ?? [],
    portal_permissions: portal.permissions ?? [],
    effective_permissions: provisioned.effective_permissions,
    allowed_kb_ids: provisioned.actor.allowed_kb_ids,
  };
  await recordAuditEvent(state.sql, provisioned.actor, identityAction, 'app_user',
    provisioned.actor.user_id, detail);
  if (provisioned.was_clamped) {
    await recordAuditEvent(state.sql, provisioned.actor, 'portal.permission.clamped',
      'tenant_member', provisioned.actor.tenant_id, detail);
  }
  await recordAuditEvent(state.sql, provisioned.actor, 'portal.login.success',
    'auth_session', sessionId, detail);
  return portalSuccessHtml(token, provisioned.actor);
}

async function exchangePortalTicket(state: AppState, code: string): Promise<PortalContext> {
  const base = state.config.portalBaseUrl.replace(/\/+$/, '');
  const endpoint = state.config.portalExchangeEndpoint.startsWith('/')
    ? `${base}${state.config.portalExchangeEndpoint}`
    : `${base}/${state.config.portalExchangeEndpoint}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system_code: 'documind', code }),
  });
  if (!response.ok) throw AppError.unauthorized();
  return (await response.json()) as PortalContext;
}

interface PortalProvisionResult {
  actor: import('../models/identity.ts').CurrentActor;
  identity_created: boolean; was_clamped: boolean; effective_permissions: string[];
}

async function provisionPortalActor(
  state: AppState, portal: PortalContext, roles: string[],
): Promise<PortalProvisionResult> {
  const sql = state.sql;
  if (!sql) {
    throw AppError.badRequest('PORTAL_REQUIRES_DB', 'database is required for portal managed auth');
  }
  const tenantName = (portal.tenant_name ?? '').trim().length > 0 ? portal.tenant_name! : 'Portal Tenant';
  const tenantSlug = (portal.tenant_code ? slugify(portal.tenant_code) : '')
    || `tenant-${portal.tenant_id.slice(0, 8)}`;

  await sql`
    INSERT INTO tenant (id, name, slug, status)
    VALUES (${portal.tenant_id}, ${tenantName}, ${tenantSlug}, 'active')
    ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name, slug = EXCLUDED.slug, status = 'active', updated_at = NOW()
  `;

  const email = (portal.email ?? '').trim().length > 0
    ? portal.email! : `${portal.user_id}@portal.local`;
  const displayName = portal.display_name.trim().length === 0 ? portal.username : portal.display_name;
  const existingPortal = await sql`
    SELECT id FROM app_user WHERE auth_provider = 'portal' AND sso_subject = ${portal.user_id} LIMIT 1
  `;
  const identityCreated = existingPortal.length === 0;
  let userId: string | null = existingPortal[0] ? String(existingPortal[0].id) : null;
  if (!userId) {
    const byEmail = await sql`
      SELECT id FROM app_user WHERE lower(email) = lower(${email}) LIMIT 1
    `;
    userId = byEmail[0] ? String(byEmail[0].id) : null;
  }
  if (!userId) userId = newUuid();
  const localPermissions = derivePermissions(roles);
  const mappedPortalPermissions = mapPortalPermissions(portal.permissions ?? []);
  const effectivePermissions = intersectPermissions(localPermissions, mappedPortalPermissions);
  const wasClamped = effectivePermissions.length < localPermissions.length;
  const attributes = {
    auth_provider: 'portal', portal_user_id: portal.user_id, portal_tenant_id: portal.tenant_id,
    portal_permissions: portal.permissions ?? [],
    mapped_portal_permissions: mappedPortalPermissions,
    effective_permissions: effectivePermissions,
    system_roles: portal.system_roles ?? [], portal_roles: portal.portal_roles ?? [],
  };
  await sql`
    INSERT INTO app_user
      (id, login_id, email, name, auth_provider, sso_subject, last_active_tenant, status)
    VALUES (${userId}, ${email}, ${email}, ${displayName}, 'portal', ${portal.user_id}, ${portal.tenant_id}, 'active')
    ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email, name = EXCLUDED.name, auth_provider = 'portal',
        sso_subject = EXCLUDED.sso_subject, last_active_tenant = EXCLUDED.last_active_tenant,
        status = 'active', updated_at = NOW()
  `;

  if (roles.includes('super_admin')) {
    await sql`
      INSERT INTO platform_admin (user_id, role, status)
      VALUES (${userId}, 'super_admin', 'active')
      ON CONFLICT (user_id)
      DO UPDATE SET role = 'super_admin', status = 'active', updated_at = NOW()
    `;
  }

  await sql`
    INSERT INTO tenant_member (tenant_id, user_id, roles, attributes, status, joined_at, last_seen_at)
    VALUES (${portal.tenant_id}, ${userId}, ${roles}, ${sql.json(attributes)}, 'active', NOW(), NOW())
    ON CONFLICT (tenant_id, user_id) DO UPDATE
    SET roles = EXCLUDED.roles, attributes = EXCLUDED.attributes, status = 'active',
        last_seen_at = NOW()
  `;

  const claims: Claims = {
    sub: userId, email, role: roles[0] ?? 'end_user',
    scope: roles.includes('super_admin') ? 'platform' : 'tenant',
    tenant_id: portal.tenant_id, sid: null,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const actor = await actorFromClaims({ sql, config: state.config }, claims);
  return { actor, identity_created: identityCreated, was_clamped: wasClamped, effective_permissions: effectivePermissions };
}

export function mapDocumindRoles(portal: PortalContext): string[] {
  const mapped: string[] = [];
  const candidates = [
    ...(portal.system_roles ?? []).map(mapDocumindRole),
    ...(portal.portal_roles ?? []).map(mapPortalRoleForDocumind),
  ];
  for (const role of candidates) {
    if (role !== null && !mapped.includes(role)) mapped.push(role);
  }
  if (mapped.length === 0) mapped.push('end_user');
  return sortDocumindRolesByPriority(mapped);
}

export function mapPortalPermissions(values: string[]): string[] {
  return [...new Set(values.map(mapPortalPermission).filter((value): value is string => value !== null))].sort();
}

function mapPortalPermission(value: string): string | null {
  switch (value.trim()) {
    case 'documind:chat:ask': case 'chat.ask': return 'chat.ask';
    case 'documind:knowledge:read': case 'kb.read': return 'kb.read';
    case 'documind:knowledge:create': case 'kb.create': return 'kb.create';
    case 'documind:knowledge:write': case 'kb.write': return 'kb.write';
    case 'documind:knowledge:manage': case 'kb.manage': return 'kb.manage';
    case 'documind:document:upload': case 'document.upload': return 'document.upload';
    case 'documind:document:delete': case 'document.delete': return 'document.delete';
    case 'documind:document:reprocess': case 'document.reprocess': return 'document.reprocess';
    case 'documind:member:read': case 'member.read': return 'member.read';
    case 'documind:member:write': case 'member.write': return 'member.write';
    case 'documind:member:delete': case 'member.delete': return 'member.delete';
    case 'documind:config:read': case 'config.read': return 'config.read';
    case 'documind:config:write': case 'config.write': return 'config.write';
    case 'documind:audit:read': case 'audit.read': return 'audit.read';
    case 'documind:model:manage': case 'model.write': return 'model.write';
    case 'documind:answer:feedback': case 'answer.feedback': return 'answer.feedback';
    case 'documind:tenant:read': case 'tenant.read': return 'tenant.read';
    case 'documind:tenant:write': case 'tenant.write': return 'tenant.write';
    case 'documind:user:read': case 'user.read': return 'user.read';
    case 'documind:user:write': case 'user.write': return 'user.write';
    default: return null;
  }
}

export function intersectPermissions(local: string[], portal: string[]): string[] {
  return [...new Set(local.filter((permission) => portal.includes(permission)))].sort();
}

function mapDocumindRole(role: string): string | null {
  switch (role) {
    case 'super_admin': return 'super_admin';
    case 'tenant_owner': case 'tenant_admin': return 'tenant_admin';
    case 'enterprise_admin': case 'team_admin': case 'data_admin': return 'tenant_admin';
    case 'analyst': case 'user': case 'viewer': case 'end_user': return 'end_user';
    default: return null;
  }
}

function mapPortalRoleForDocumind(role: string): string | null {
  switch (role) {
    case 'super-admin': case 'super_admin': return 'super_admin';
    case 'tenant-owner': case 'tenant_owner': return 'tenant_admin';
    case 'tenant-admin': case 'tenant_admin': return 'tenant_admin';
    case 'module-admin': case 'module_admin': case 'subsystem-admin': case 'subsystem_admin': return 'tenant_admin';
    case 'admin': case 'enterprise-admin': case 'enterprise_admin': return 'tenant_admin';
    case 'normal-user': case 'normal_user': case 'normal': case 'user': case 'viewer': case 'end_user': return 'end_user';
    default: return null;
  }
}

function sortDocumindRolesByPriority(roles: string[]): string[] {
  const priority = ['super_admin', 'tenant_admin', 'end_user'];
  return priority.filter((role) => roles.includes(role));
}

function portalSuccessHtml(token: string, actor: import('../models/identity.ts').CurrentActor): Response {
  const auth = {
    token, userId: actor.user_id, tenantId: actor.tenant_id,
    email: actor.email, roles: actor.roles,
  };
  const target = AUTHENTICATED_HOME_PATH;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>DocuMind 登录中</title></head>
<body>
<script>
const auth = ${JSON.stringify(auth)};
const prefix = window.location.pathname.startsWith("/documind/") || window.location.pathname === "/documind" ? "/documind" : "";
const target = ${JSON.stringify(target)};
localStorage.setItem("documind-auth", JSON.stringify(auth));
window.location.replace(prefix + target);
</script>
</body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function portalCallbackError(error: AppError): Response {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>DocuMind 登录失败</title></head>
<body><p>门户登录失败：${htmlEscape(error.message)}</p></body></html>`;
  return new Response(html, { status: error.httpStatus, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function portalErrorCode(error: AppError): string {
  switch (error.kind) {
    case 'not_found': return 'not_found';
    case 'forbidden': return 'forbidden';
    case 'conflict': return 'conflict';
    case 'invalid_state': return 'invalid_state';
    case 'timeout': return 'timeout';
    case 'bad_request': return 'bad_request';
    case 'unauthorized': return 'unauthorized';
    case 'rate_limited': return 'rate_limited';
    case 'internal': return 'internal_error';
  }
}

export function slugify(value: string): string {
  let out = '';
  for (const ch of value) {
    if (/[a-z0-9]/i.test(ch)) out += ch.toLowerCase();
    else if ((ch === '-' || ch === '_' || /\s/.test(ch)) && !out.endsWith('-')) out += '-';
  }
  return out.replace(/^-+|-+$/g, '').slice(0, 63);
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function invitationTokenHash(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex');
}

export function normalizeInvitationAccount(value: string): string {
  const account = value.trim().toLowerCase();
  const chars = [...account];
  if (chars.length < 2 || chars.length > 128
    || !chars.every((ch) => /[a-z0-9]/i.test(ch) || ['.', '_', '-', '@', '+'].includes(ch))) {
    throw AppError.badRequest('ACCOUNT_INVALID', '请输入有效账号');
  }
  return account;
}

async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) {
    throw AppError.badRequest('PASSWORD_TOO_SHORT', '密码至少需要 8 个字符');
  }
  return bcrypt.hash(password, 10);
}

async function identityProfile(sql: Sql, userId: string): Promise<UserProfile> {
  const rows = await sql`
    SELECT id, login_id, email, name, avatar_url, status
    FROM app_user WHERE id = ${userId} AND status = 'active' LIMIT 1
  `;
  const user = rows[0];
  if (!user) throw AppError.unauthorized();
  return {
    id: String(user.id), login_id: String(user.login_id),
    email: String(user.email ?? ''), name: (user.name as string | null) ?? null,
    avatar_url: (user.avatar_url as string | null) ?? null, status: String(user.status),
  };
}

async function identityTenants(sql: Sql, userId: string): Promise<TenantProfile[]> {
  const rows = await sql`
    SELECT t.id, t.name, t.slug, t.plan, t.status, tm.roles
    FROM tenant_member tm
    JOIN tenant t ON t.id = tm.tenant_id
    WHERE tm.user_id = ${userId} AND tm.status = 'active' AND t.status = 'active'
      AND NOT ('super_admin' = ANY(tm.roles))
    ORDER BY t.name ASC
  `;
  return rows.map((tenant) => ({
    id: String(tenant.id), name: String(tenant.name), slug: String(tenant.slug),
    plan: String(tenant.plan), status: String(tenant.status), roles: tenant.roles as string[],
  }));
}

async function identityLoginResponse(
  state: AppState, userId: string, sessionId: string,
): Promise<LoginResponse> {
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '账号功能需要数据库');
  const user = await identityProfile(sql, userId);
  return {
    access_token: await issueIdentityToken(state.config, {
      user_id: user.id, email: user.email,
    }, sessionId),
    token_type: 'bearer', scope: 'tenant', user, tenant: null,
    roles: [], permissions: [], allowed_kb_ids: [],
    tenants: await identityTenants(sql, userId),
  };
}

async function registerHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '注册功能需要数据库');
  const req = await c.req.json() as RegisterRequest;
  const username = (req.username ?? '').trim().toLowerCase();
  const password = req.password ?? '';
  if (!username || !password) {
    throw AppError.badRequest('CREDENTIALS_REQUIRED', '请输入用户名和密码');
  }
  if (new TextEncoder().encode(password).length > 72) {
    throw AppError.badRequest('PASSWORD_TOO_LONG', '密码不能超过 72 字节');
  }
  const passwordHash = await bcrypt.hash(password, 10);
  let userId: string;
  try {
    const rows = await sql`
      INSERT INTO app_user (login_id, email, name, password_hash, auth_provider, status)
      VALUES (${username}, NULL, ${username}, ${passwordHash}, 'password', 'active')
      RETURNING id
    `;
    userId = String(rows[0]!.id);
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw AppError.conflictWith('USERNAME_TAKEN', '用户名已被使用');
    }
    throw error;
  }
  const sessionId = await createIdentitySession(state.redis, state.config, userId);
  return c.json(await identityLoginResponse(state, userId, sessionId), 201);
}

async function tenantLoginResponse(
  state: AppState, actor: CurrentActor, sessionId: string,
): Promise<LoginResponse> {
  const me = await meResponse(state, actor);
  return {
    access_token: await issueToken(state.config, actor, sessionId),
    token_type: 'bearer', scope: me.scope, user: me.user, tenant: me.tenant,
    roles: me.roles, permissions: me.permissions, allowed_kb_ids: me.allowed_kb_ids,
    tenants: state.sql ? await identityTenants(state.sql, actor.user_id) : [me.tenant],
  };
}

async function authTenantsHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '租户功能需要数据库');
  const claims = await claimsFromAuthorizationHeader(
    state.config, c.req.header('authorization') ?? null);
  await validateAndRenewAuthSession(state.redis, state.config, claims);
  return c.json({
    items: await identityTenants(sql, claims.sub),
    active_tenant_id: claims.tenant_id,
  });
}

async function switchTenantHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '租户功能需要数据库');
  const claims = await claimsFromAuthorizationHeader(
    state.config, c.req.header('authorization') ?? null);
  await validateAndRenewAuthSession(state.redis, state.config, claims);
  const req = await c.req.json() as { tenant_id?: string };
  const tenantId = (req.tenant_id ?? '').trim();
  const rows = await sql`
    SELECT EXISTS(
      SELECT 1 FROM tenant_member tm
      JOIN tenant t ON t.id = tm.tenant_id
      WHERE tm.user_id = ${claims.sub} AND tm.tenant_id = ${tenantId}
        AND tm.status = 'active' AND t.status = 'active'
        AND NOT ('super_admin' = ANY(tm.roles))
    ) AS active
  `;
  if (!rows[0]?.active) {
    throw AppError.forbiddenWith(
      'TENANT_MEMBERSHIP_NOT_FOUND', '当前账号不属于该租户或租户不可用');
  }
  await sql`
    UPDATE app_user SET last_active_tenant = ${tenantId}, updated_at = NOW()
    WHERE id = ${claims.sub}
  `;
  const actor = await actorFromClaims({ sql, config: state.config }, {
    ...claims, tenant_id: tenantId, role: 'end_user', scope: 'tenant',
  });
  const sessionId = claims.sid ?? await createAuthSession(state.redis, state.config, actor);
  await setAuthSessionTenant(
    state.redis, state.config, sessionId, actor.user_id, tenantId, actor.roles[0] ?? 'end_user');
  return c.json(await tenantLoginResponse(state, actor, sessionId));
}

async function createTenantHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '租户功能需要数据库');
  const claims = await claimsFromAuthorizationHeader(
    state.config, c.req.header('authorization') ?? null);
  await validateAndRenewAuthSession(state.redis, state.config, claims);
  const idempotencyKey = (c.req.header('idempotency-key') ?? '').trim();
  if (!idempotencyKey) {
    throw AppError.badRequest('IDEMPOTENCY_KEY_REQUIRED', '缺少 Idempotency-Key');
  }
  const req = await c.req.json() as { name?: string };
  const name = (req.name ?? '').trim();
  if (!name || [...name].length > 128) {
    throw AppError.badRequest('TENANT_NAME_INVALID', '租户名称不能为空且不能超过 128 个字符');
  }
  const existing = await sql`
    SELECT tenant_id FROM tenant_creation_request
    WHERE user_id = ${claims.sub} AND idempotency_key = ${idempotencyKey}
  `;
  let tenantId = existing[0] ? String(existing[0].tenant_id) : '';
  if (!tenantId) {
    tenantId = newUuid();
    const slug = `tenant-${tenantId.slice(0, 8)}`;
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO tenant (id, name, slug, plan, status)
        VALUES (${tenantId}, ${name}, ${slug}, 'enterprise', 'active')
      `;
      await tx`
        INSERT INTO tenant_member (tenant_id, user_id, roles, status, joined_at)
        VALUES (${tenantId}, ${claims.sub}, ${['tenant_owner']}, 'active', NOW())
      `;
      const kbRows = await tx`
        INSERT INTO knowledge_base (tenant_id, name, description, status, created_by)
        VALUES (${tenantId}, '默认知识库', '新租户默认知识库', 'active', ${claims.sub})
        RETURNING id
      `;
      await tx`
        INSERT INTO knowledge_base_acl
          (tenant_id, kb_id, subject_type, subject_id, permission, created_by)
        VALUES
          (${tenantId}, ${kbRows[0]!.id}, 'role', 'tenant_admin', 'manage', ${claims.sub})
      `;
      await tx`
        INSERT INTO tenant_creation_request (user_id, idempotency_key, tenant_id)
        VALUES (${claims.sub}, ${idempotencyKey}, ${tenantId})
      `;
      await tx`
        UPDATE app_user SET last_active_tenant = ${tenantId}, updated_at = NOW()
        WHERE id = ${claims.sub}
      `;
    });
  }
  const actor = await actorFromClaims({ sql, config: state.config }, {
    ...claims, tenant_id: tenantId, role: 'tenant_admin', scope: 'tenant',
  });
  const sessionId = claims.sid ?? await createAuthSession(state.redis, state.config, actor);
  await setAuthSessionTenant(
    state.redis, state.config, sessionId, actor.user_id, tenantId, actor.roles[0] ?? 'tenant_admin');
  return c.json(await tenantLoginResponse(state, actor, sessionId), 201);
}

// ---------- handlers ----------

async function getMeHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const claims = await claimsFromAuthorizationHeader(
    state.config, c.req.header('authorization') ?? null);
  await validateAndRenewAuthSession(state.redis, state.config, claims);
  if (!claims.tenant_id) {
    if (!state.sql) throw AppError.badRequest('DB_REQUIRED', '账号功能需要数据库');
    return c.json({
      scope: 'tenant', user: await identityProfile(state.sql, claims.sub), tenant: null,
      roles: [], permissions: [], allowed_kb_ids: [],
      tenants: await identityTenants(state.sql, claims.sub),
    });
  }
  const actor = await actorFromClaims({ sql: state.sql, config: state.config }, claims);
  const me = await meResponse(state, actor);
  return c.json({
    ...me,
    tenants: state.sql ? await identityTenants(state.sql, actor.user_id) : [me.tenant],
  });
}

async function permissionMeHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  const me = await meResponse(state, actor);
  return c.json({
    user_id: me.user.id, tenant_id: me.tenant.id,
    roles: me.roles, permissions: me.permissions, allowed_kb_ids: me.allowed_kb_ids,
  });
}

function permissionMatrixHandler(c: import('hono').Context<AppEnv>) {
  return c.json({ roles: roleMatrix() });
}

async function loginHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const req = await c.req.json() as LoginRequest;
  const username = (req.username ?? req.email ?? '').trim();
  const password = req.password ?? '';
  let tenantKey: string | null = null;

  if (state.sql) {
    const users = await state.sql`
      SELECT id, password_hash, last_active_tenant, status
      FROM app_user WHERE lower(login_id) = lower(${username}) LIMIT 1
    `;
    const user = users[0];
    const passwordHash = user?.password_hash == null ? '' : String(user.password_hash);
    if (!user || user.status !== 'active' || !passwordHash
      || !await bcrypt.compare(password, passwordHash)) {
      throw AppError.unauthorized();
    }
    const userId = String(user.id);
    const memberships = await state.sql`
      SELECT tm.tenant_id
      FROM tenant_member tm
      JOIN tenant t ON t.id = tm.tenant_id
      WHERE tm.user_id = ${userId}
        AND tm.status = 'active' AND t.status = 'active'
        AND NOT ('super_admin' = ANY(tm.roles))
    `;
    const platformRows = await state.sql`
      SELECT EXISTS(
        SELECT 1 FROM platform_admin WHERE user_id = ${userId} AND status = 'active'
      ) AS active
    `;
    if (!platformRows[0]?.active) {
      const lastActive = user.last_active_tenant == null ? null : String(user.last_active_tenant);
      const selected = memberships.length === 1
        ? String(memberships[0]!.tenant_id)
        : memberships.some((membership) => String(membership.tenant_id) === lastActive)
          ? lastActive
          : null;
      if (!selected) {
        const sessionId = await createIdentitySession(state.redis, state.config, userId);
        return c.json(await identityLoginResponse(state, userId, sessionId));
      }
      tenantKey = selected;
    }
  }

  let actor;
  try {
    actor = await authenticate(
      { sql: state.sql, config: state.config }, username, password, tenantKey);
  } catch (error) {
    await recordAuditEvent(state.sql, null, 'auth.login_failed', 'auth_session', null, {
      username,
    }).catch(() => undefined);
    throw error;
  }
  await recordAuditEvent(state.sql, actor, 'auth.login_succeeded', 'auth_session', null, {
    login_id: actor.login_id, scope: actor.scope, roles: actor.roles,
  });
  const me = await meResponse(state, actor);
  const sessionId = await createAuthSession(state.redis, state.config, actor);
  const body: LoginResponse = {
    access_token: await issueToken(state.config, actor, sessionId),
    token_type: 'bearer', scope: me.scope, user: me.user, tenant: me.tenant,
    roles: me.roles, permissions: me.permissions, allowed_kb_ids: me.allowed_kb_ids,
    tenants: state.sql ? await identityTenants(state.sql, actor.user_id) : [me.tenant],
  };
  return c.json(body);
}

async function refreshHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const claims = await claimsFromAuthorizationHeader(state.config, c.req.header('authorization') ?? null);
  await validateAndRenewAuthSession(state.redis, state.config, claims);
  if (!claims.tenant_id) {
    if (!claims.sid) throw AppError.unauthorized();
    return c.json(await identityLoginResponse(state, claims.sub, claims.sid));
  }
  const actor = await actorFromClaims({ sql: state.sql, config: state.config }, claims);
  const me = await meResponse(state, actor);
  const body: LoginResponse = {
    access_token: await issueToken(state.config, actor, claims.sid),
    token_type: 'bearer', scope: me.scope, user: me.user, tenant: me.tenant,
    roles: me.roles, permissions: me.permissions, allowed_kb_ids: me.allowed_kb_ids,
    tenants: state.sql ? await identityTenants(state.sql, actor.user_id) : [me.tenant],
  };
  return c.json(body);
}

async function logoutHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  try {
    const claims = await claimsFromAuthorizationHeader(state.config, c.req.header('authorization') ?? null);
    if (claims.sid !== null) {
      await deleteAuthSession(state.redis, claims.sid).catch(() => undefined);
    }
  } catch { /* logout 幂等 */ }
  return c.json({ ok: true });
}

async function acceptInvitationHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const req = await c.req.json() as AcceptInvitationRequest;
  return c.json(await acceptInvitation(state, req));
}


async function acceptInvitation(state: AppState, req: AcceptInvitationRequest): Promise<LoginResponse> {
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '邀请功能需要数据库');
  const token = (req.token ?? '').trim();
  if (token.length === 0) throw AppError.badRequest('INVITATION_TOKEN_REQUIRED', '邀请链接无效');

  const tokenHash = invitationTokenHash(token);
  return sql.begin(async (tx) => {
    const invitations = await tx.unsafe(`
      SELECT inv.id, inv.tenant_id, inv.email, inv.name, inv.roles, inv.kb_grants,
             inv.invited_by, inv.status, inv.expires_at, t.status AS tenant_status
      FROM tenant_invitation inv
      JOIN tenant t ON t.id = inv.tenant_id
      WHERE inv.token_hash = '${tokenHash}'
      LIMIT 1
      FOR UPDATE OF inv, t
    `);
    const invitation = invitations[0];
    if (!invitation) {
      throw AppError.notFound('INVITATION_NOT_FOUND', '邀请不存在或已失效');
    }
    const invitationId = String(invitation.id);
    const tenantId = String(invitation.tenant_id);
    const invitedEmail = (invitation.email as string | null) ?? null;
    const loginId = normalizeInvitationAccount(req.login_id ?? '');
    const invitationName = (invitation.name as string | null) ?? null;
    const invitationRoles = (invitation.roles as string[]) ?? [];
    const roles = [...new Set(invitationRoles.flatMap((role) => {
      switch (role) {
        case 'tenant_admin': case 'enterprise_admin': case 'team_admin':
        case 'data_admin': case 'tenant_owner': return ['tenant_admin'];
        case 'end_user': case 'user': case 'analyst': case 'viewer': return ['end_user'];
        default: return [];
      }
    }))].sort();

    const status = String(invitation.status);
    const expiresAt = new Date(invitation.expires_at as Date | string);
    const tenantStatus = String(invitation.tenant_status);
    if (status !== 'pending') {
      throw AppError.conflictWith('INVITATION_NOT_PENDING', '邀请已被接受、撤销或失效');
    }
    if (expiresAt.getTime() < Date.now()) {
      await tx.unsafe(`UPDATE tenant_invitation SET status = 'expired', updated_at = NOW() WHERE id = '${invitationId}'`);
      throw AppError.conflictWith('INVITATION_EXPIRED', '邀请已过期');
    }
    if (roles.length === 0 || invitationRoles.includes('super_admin')) {
      throw AppError.forbiddenWith('INVITATION_ROLE_FORBIDDEN', '邀请角色无效或无权授予');
    }
    const primaryRole = roles[0]!;
    const activatesPendingTenant = tenantStatus === 'pending' && roles.includes('tenant_admin');
    if (tenantStatus !== 'active' && !activatesPendingTenant) {
      throw AppError.conflictWith('TENANT_NOT_ACTIVE', '租户当前不可接受邀请');
    }

    const escapedLoginId = loginId.replace(/'/g, "''");
    const existingUsers = await tx.unsafe(`
      SELECT u.id, u.email, u.password_hash, u.status
      FROM app_user u
      WHERE lower(u.login_id) = lower('${escapedLoginId}')
      LIMIT 1
      FOR UPDATE OF u
    `);
    const displayName = (req.name ?? '').trim().length > 0 ? req.name!.trim()
      : invitationName ?? loginId;

    let updateExistingMembership = false;
    let userId: string;
    const existingUser = existingUsers[0];
    if (existingUser) {
      userId = String(existingUser.id);
      const userStatus = String(existingUser.status);
      const existingEmail = (existingUser.email as string | null) ?? null;
      if (invitedEmail !== null
        && (existingEmail === null || existingEmail.toLowerCase() !== invitedEmail.toLowerCase())) {
        throw AppError.forbiddenWith('INVITATION_EMAIL_MISMATCH', '该邀请不属于此账号');
      }
      if (userStatus !== 'active') {
        throw AppError.forbiddenWith('ACCOUNT_NOT_ACTIVE', '账号已停用，不能接受邀请');
      }
      const passwordHash = (existingUser.password_hash as string | null) ?? null;
      const password = req.password ?? null;
      if (password === null) {
        throw AppError.badRequest('PASSWORD_REQUIRED', '已有账号接受邀请需要验证密码');
      }
      const passwordMatches = passwordHash !== null && passwordHash.length > 0
        && await bcrypt.compare(password, passwordHash);
      if (!passwordMatches) {
        throw AppError.unauthorizedWith('INVITATION_ACCOUNT_VERIFICATION_FAILED', '账号密码验证失败');
      }
      const memberships = await tx.unsafe(`
        SELECT roles FROM tenant_member
        WHERE tenant_id = '${tenantId}' AND user_id = '${userId}' FOR UPDATE
      `);
      updateExistingMembership = memberships.length > 0;
    } else {
      const password = req.password ?? null;
      if (password === null) {
        throw AppError.badRequest('PASSWORD_REQUIRED', '首次接受邀请需要设置密码');
      }
      userId = newUuid();
      const passwordHash = await hashPassword(password);
      await tx`
        INSERT INTO app_user
          (id, login_id, email, name, password_hash, auth_provider, last_active_tenant, status)
        VALUES (${userId}, ${loginId}, ${invitedEmail}, ${displayName}, ${passwordHash}, 'local', ${tenantId}, 'active')
      `;
    }

    const invitedBy = String(invitation.invited_by);
    if (updateExistingMembership) {
      await tx`
        UPDATE tenant_member
        SET roles = ${roles}, status = 'active', invited_by = ${invitedBy},
            invited_at = NOW(), joined_at = COALESCE(joined_at, NOW()), updated_at = NOW()
        WHERE tenant_id = ${tenantId} AND user_id = ${userId}
      `;
    } else {
      await tx`
        INSERT INTO tenant_member (tenant_id, user_id, roles, status, invited_by, invited_at, joined_at)
        VALUES (${tenantId}, ${userId}, ${roles}, 'active', ${invitedBy}, NOW(), NOW())
      `;
    }

    const grantsValue = invitation.kb_grants;
    const grants: InvitationGrantStored[] = Array.isArray(grantsValue) ? grantsValue as InvitationGrantStored[] : [];
    for (const grant of grants) {
      await tx`
        INSERT INTO knowledge_base_acl
          (tenant_id, kb_id, subject_type, subject_id, permission, created_by)
        VALUES (${tenantId}, ${grant.kb_id}, 'user', ${userId}, ${grant.permission}, NULL)
        ON CONFLICT (tenant_id, kb_id, subject_type, subject_id, permission) DO NOTHING
      `;
    }

    await tx`
      UPDATE tenant_invitation
      SET status = 'accepted', accepted_by = ${userId}, accepted_at = NOW(), updated_at = NOW()
      WHERE id = ${invitationId}
    `;
    if (activatesPendingTenant) {
      await tx.unsafe(`UPDATE tenant SET status = 'active', updated_at = NOW() WHERE id = '${tenantId}'`);
    }
    await tx`
      UPDATE app_user SET last_active_tenant = ${tenantId}, updated_at = NOW() WHERE id = ${userId}
    `;
    await tx`
      INSERT INTO audit_log
        (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
      VALUES (${tenantId}, ${userId}, ${primaryRole}, 'tenant_invitation.accept',
        'tenant_invitation', ${invitationId}, ${tx.json({ login_id: loginId, roles })})
    `;

    const claims: Claims = {
      sub: userId, email: invitedEmail ?? '', role: primaryRole, scope: 'tenant',
      tenant_id: tenantId, sid: null, exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const actor = await actorFromClaims({ sql, config: state.config }, claims);
    const sessionId = await createAuthSession(state.redis, state.config, actor);
    const accessToken = await issueToken(state.config, actor, sessionId);
    const me = await meResponse(state, actor);
    return {
      access_token: accessToken, token_type: 'bearer', scope: me.scope,
      user: me.user, tenant: me.tenant, roles: me.roles,
      permissions: me.permissions, allowed_kb_ids: me.allowed_kb_ids,
    } satisfies LoginResponse;
  });
}

export async function meResponse(
  state: AppState, actor: import('../models/identity.ts').CurrentActor,
): Promise<MeResponse> {
  const tenant = await tenantProfile(state, actor.tenant_id);
  let avatarUrl: string | null = null;
  if (state.sql) {
    const rows = await state.sql`
      SELECT avatar_url FROM app_user WHERE id = ${actor.user_id}
    `;
    avatarUrl = (rows[0]?.avatar_url as string | null) ?? null;
  }
  return {
    scope: actor.scope,
    user: {
      id: actor.user_id, login_id: actor.login_id, email: actor.email,
      name: actor.name, avatar_url: avatarUrl, status: 'active',
    },
    tenant,
    roles: actor.roles, permissions: actor.permissions, allowed_kb_ids: actor.allowed_kb_ids,
  };
}

async function tenantProfile(state: AppState, tenantId: string): Promise<TenantProfile> {
  if (state.sql) {
    const rows = await state.sql`
      SELECT id, name, slug, plan, status FROM tenant WHERE id = ${tenantId}
    `;
    const row = rows[0];
    if (row) {
      return {
        id: String(row.id), name: String(row.name), slug: String(row.slug),
        plan: String(row.plan), status: String(row.status),
      };
    }
  }
  return {
    id: state.config.defaultTenantId, name: state.config.defaultTenantName,
    slug: state.config.defaultTenantSlug, plan: 'enterprise', status: 'active',
  };
}
