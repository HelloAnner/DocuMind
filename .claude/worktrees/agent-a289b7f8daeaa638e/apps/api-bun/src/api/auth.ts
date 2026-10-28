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
import { derivePermissions, requirePermission, roleMatrix } from '../auth/permissions.ts';
import type { CurrentActor, MeResponse, TenantProfile, UserProfile } from '../models/identity.ts';
import type { LoginResponse } from './auth_types.ts';
import { newUuid } from '../infra/uuid.ts';
import {
  invitationTokenHash,
  normalizeInvitationAccount,
} from './system_tenants.ts';
export { normalizeInvitationAccount } from './system_tenants.ts';

const AUTHENTICATED_HOME_PATH = '/chat';

interface LoginRequest {
  username?: string | null; email?: string | null; password: string;
  tenant_id?: string | null; tenant_slug?: string | null;
}
interface RegisterRequest { username: string; password: string; }
interface AcceptInvitationRequest { token: string; }
interface InvitationGrantStored { kb_id: string; permission: string; }

export function authRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/auth/portal/callback', portalCallbackHandler);
  router.post('/api/auth/portal/ticket', portalTicketHandler);
  router.post('/api/auth/portal/link', portalLinkHandler);
  router.post('/api/auth/portal/create', portalCreateHandler);
  router.post('/api/auth/portal/tenant-mapping', approvePortalTenantMapping);
  router.get('/api/me', getMeHandler);
  router.post('/api/auth/login', loginHandler);
  router.post('/api/auth/refresh', refreshHandler);
  router.post('/api/auth/logout', logoutHandler);
  router.post('/api/v1/invitations/validate', validateInvitationHandler);
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
async function portalTicketHandler(c: import('hono').Context<AppEnv>) {
  const body = await c.req.json().catch(() => {
    throw AppError.badRequest('INVALID_PORTAL_TICKET', '无效的门户票据');
  }) as { code?: unknown; create_intent?: unknown };
  if (typeof body?.code !== 'string' || (body.create_intent !== undefined
    && typeof body.create_intent !== 'boolean')) throw AppError.unauthorized();
  return portalCallbackInner(c.get('appState'), { code: body.code }, true, body.create_intent === true);
}


async function portalCallbackInner(
  state: AppState, query: PortalCallbackQuery, json = false, createIntent = false,
): Promise<Response> {
  if ((!state.config.portalAuthEnabled && state.config.authLoginMode !== 'portal') || !state.sql || !state.redis) throw AppError.unauthorized();
  if (!query.code || !/^[0-9a-f-]{36}:[^:\s]+$/i.test(query.code)) throw AppError.unauthorized();
  const portal = await exchangePortalTicket(state, query.code);
  validatePortalContext(portal);
  const roles = mapDocumindRoles(portal);
  const mappedTenant = await resolvePortalTenant(state.sql, portal, false);
  const existing = mappedTenant ? await state.sql`
    SELECT local_user_id AS id FROM portal_identity_mapping
    WHERE portal_user_id = ${portal.user_id} AND portal_tenant_id = ${portal.tenant_id}
      AND local_tenant_id = ${mappedTenant}
  ` : [];
  if (!existing.length) {
    const conflict = mappedTenant ? await state.sql`
      SELECT u.id, u.sso_subject FROM app_user u
      JOIN tenant_member tm ON tm.user_id = u.id AND tm.tenant_id = ${mappedTenant}
        AND tm.status = 'active'
      WHERE (NULLIF(${portal.email ?? ''}, '') IS NOT NULL AND lower(u.email) = lower(${portal.email ?? ''}))
         OR lower(u.login_id) = lower(${portal.username})
      LIMIT 2
    ` : [];
    if (conflict.some((row) => row.sso_subject && row.sso_subject !== portal.user_id)) {
      throw AppError.forbidden();
    }
    if (createIntent && conflict.length) throw AppError.forbidden();
    const mapping = mappedTenant ? await state.sql`
      SELECT origin FROM portal_tenant_mapping
      WHERE portal_tenant_id = ${portal.tenant_id} AND tenant_id = ${mappedTenant}
    ` : [];
    if (conflict.length || (mapping[0]?.origin === 'approved' && !createIntent)) {
      const challenge = crypto.randomUUID();
      await state.redis.set(`documind:portal:link:${challenge}`, JSON.stringify({
        portal, user_ids: conflict.map((row) => String(row.id)),
      }), 'EX', 300);
      if (json) return Response.json({
        code: 'PORTAL_LINK_REQUIRED',
        message: '请用已验证的本地会话关联；如无历史账号，明确选择创建新账号',
        challenge,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
      return portalLinkHtml(challenge, conflict.length === 0);
    }
  }
  return finishPortalLogin(state, portal, roles, json);
}

function validatePortalContext(portal: PortalContext, requireFresh = true): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (portal.system_code !== 'documind' || !Number.isSafeInteger(portal.expires_at)
    || (requireFresh && (portal.expires_at <= Math.floor(Date.now() / 1000)
      || portal.expires_at > Math.floor(Date.now() / 1000) + 60))
    || !uuid.test(portal.user_id) || !uuid.test(portal.tenant_id)
    || !portal.username?.trim() || !portal.display_name?.trim()
    || !portal.tenant_code?.trim() || !Array.isArray(portal.system_roles)
    || !Array.isArray(portal.permissions)) throw AppError.unauthorized();
}

async function approvePortalTenantMapping(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  if ((!state.config.portalAuthEnabled && state.config.authLoginMode !== 'portal') || !state.sql || !state.redis
    || actor.is_super_admin
    || !actor.roles.some((role) => role === 'tenant_owner' || role === 'tenant_admin')) throw AppError.forbidden();
  requirePermission(actor, 'tenant.write');
  const claims = await claimsFromAuthorizationHeader(state.config, c.req.header('authorization') ?? null);
  await validateAndRenewAuthSession(state.redis, state.config, claims);
  if (claims.auth_source !== 'local' || claims.sub !== actor.user_id
    || claims.tenant_id !== actor.tenant_id) throw AppError.unauthorized();
  const body = await c.req.json() as {
    portal_tenant_id?: string; portal_tenant_code?: string; password?: string;
  };
  const portalId = body.portal_tenant_id ?? '';
  const portalCode = body.portal_tenant_code ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(portalId)
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(portalCode)
    || portalCode.length > 63 || !body.password) throw AppError.badRequest('INVALID_PORTAL_TENANT', '无效的门户租户资料');
  const accounts = await state.sql`
    SELECT password_hash, auth_provider FROM app_user WHERE id = ${actor.user_id} AND status = 'active'
  `;
  if (!accounts[0] || !['password', 'email'].includes(String(accounts[0].auth_provider))
    || !accounts[0].password_hash || !await bcrypt.compare(body.password, String(accounts[0].password_hash))) {
    throw AppError.unauthorized();
  }
  await state.sql.begin(async (tx) => {
    const mapped = await tx`
      INSERT INTO portal_tenant_mapping
        (portal_tenant_id, portal_tenant_code, tenant_id, origin, approved_by)
      VALUES (${portalId}, ${portalCode}, ${actor.tenant_id}, 'approved', ${actor.user_id})
      ON CONFLICT DO NOTHING RETURNING tenant_id
    `;
    if (!mapped.length) throw AppError.conflictWith('PORTAL_TENANT_ALREADY_MAPPED', '门户或本地租户已有映射');
    await recordAuditEvent(tx, actor, 'portal.tenant.mapping.approved',
      'tenant', actor.tenant_id, { portal_tenant_id: portalId, portal_tenant_code: portalCode });
  });
  return c.json({ portal_tenant_id: portalId, tenant_id: actor.tenant_id });
}

export async function resolvePortalTenant(sql: Sql, portal: PortalContext, create: boolean): Promise<string | null> {
  const code = slugify(portal.tenant_code ?? '');
  if (!code) throw AppError.unauthorized();
  const mappings = await sql`
    SELECT m.tenant_id, t.status FROM portal_tenant_mapping m
    JOIN tenant t ON t.id = m.tenant_id
    WHERE m.portal_tenant_id = ${portal.tenant_id} AND m.portal_tenant_code = ${code}
  `;
  if (mappings.length) {
    if (mappings[0]!.status !== 'active') throw AppError.forbidden();
    return String(mappings[0]!.tenant_id);
  }
  const collisions = await sql`
    SELECT id FROM tenant WHERE id = ${portal.tenant_id} OR slug = ${code} LIMIT 1
  `;
  if (collisions.length) throw AppError.forbidden();
  if (!create) return null;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO tenant (id, name, slug, status)
      VALUES (${portal.tenant_id}, ${portal.tenant_name?.trim() || code}, ${code}, 'active')
    `;
    await tx`
      INSERT INTO portal_tenant_mapping (portal_tenant_id, portal_tenant_code, tenant_id, origin)
      VALUES (${portal.tenant_id}, ${code}, ${portal.tenant_id}, 'portal_created')
    `;
  });
  return portal.tenant_id;
}

/** A2A：门户账号未与本地用户建立映射时抛出，handler 转成 409 JSON-RPC error。 */
export class PortalAccountNotLinkedError extends Error {
  readonly linkUrl: string;
  constructor(linkUrl: string) {
    super('门户账号尚未关联');
    this.name = 'PortalAccountNotLinkedError';
    this.linkUrl = linkUrl;
  }
}

/** 未关联账号的引导链接：门户系统落地页。 */
export function portalSystemEnterUrl(portalBaseUrl: string): string {
  const base = portalBaseUrl.replace(/\/+$/, '');
  return `${base}/api/portal/systems/documind/enter`;
}

/**
 * A2A 专用身份解析：用 Portal 一次性票据换取 portal user/tenant，
 * 只读地查 portal_identity_mapping 得到本地用户，不创建/更新任何身份。
 * 未关联时抛 PortalAccountNotLinkedError（调用方返回 account_not_linked）。
 */
export async function resolveA2APortalActor(state: AppState, ticket: string): Promise<CurrentActor> {
  const sql = state.sql;
  if (!sql) throw AppError.unauthorized();
  if (!/^[0-9a-f-]{36}:[^:\s]+$/i.test(ticket)) throw AppError.unauthorized();
  const portal = await exchangePortalTicket(state, ticket);
  validatePortalContext(portal);
  const mappedTenant = await resolvePortalTenant(sql, portal, false);
  const rows = mappedTenant === null ? [] : await sql`
    SELECT pim.local_user_id AS id, u.status AS user_status,
           tm.roles AS roles, tm.attributes AS attributes
    FROM portal_identity_mapping pim
    JOIN app_user u ON u.id = pim.local_user_id
    JOIN tenant_member tm ON tm.tenant_id = pim.local_tenant_id
      AND tm.user_id = pim.local_user_id AND tm.status = 'active'
    WHERE pim.portal_user_id = ${portal.user_id}
      AND pim.portal_tenant_id = ${portal.tenant_id}
      AND pim.local_tenant_id = ${mappedTenant}
    LIMIT 1
  `;
  if (!rows.length || String(rows[0]!.user_status) !== 'active') {
    throw new PortalAccountNotLinkedError(portalSystemEnterUrl(state.config.portalBaseUrl));
  }
  const originRows = await sql`
    SELECT origin FROM portal_tenant_mapping
    WHERE portal_tenant_id = ${portal.tenant_id} AND tenant_id = ${mappedTenant}
  `;
  const attributes = (rows[0]!.attributes ?? {}) as { auth_provider?: string };
  const effectiveRoles = portalMembershipRoles(
    mapDocumindRoles(portal), String(originRows[0]?.origin ?? 'portal_created'),
    rows[0]!.roles as string[] | undefined,
    attributes.auth_provider === 'portal');
  const effectivePermissions = intersectPermissions(
    derivePermissions(effectiveRoles), mapPortalPermissions(portal.permissions ?? []));
  const claims: Claims = {
    sub: String(rows[0]!.id), email: portal.email ?? '', role: effectiveRoles[0]!,
    scope: 'tenant', tenant_id: mappedTenant, sid: null,
    exp: Math.floor(Date.now() / 1000) + 3600,
    auth_source: 'portal', portal_permissions: effectivePermissions,
  };
  return actorFromClaims({ sql, config: state.config }, claims);
}

async function portalLinkHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  if ((!state.config.portalAuthEnabled && state.config.authLoginMode !== 'portal') || !state.sql || !state.redis) throw AppError.unauthorized();
  const actor = c.get('actor');
  const claims = await claimsFromAuthorizationHeader(state.config, c.req.header('authorization') ?? null);
  await validateAndRenewAuthSession(state.redis, state.config, claims);
  if (claims.auth_source !== 'local' || claims.sub !== actor.user_id
    || claims.tenant_id !== actor.tenant_id) throw AppError.unauthorized();
  const req = await c.req.json() as { challenge?: string; explicit_link?: boolean };
  if (!req.challenge || !/^[0-9a-f-]{36}$/i.test(req.challenge)) throw AppError.unauthorized();
  const key = `documind:portal:link:${req.challenge}`;
  const raw = await state.redis.get(key);
  if (!raw) throw AppError.unauthorized();
  const pending = JSON.parse(raw) as { portal: PortalContext; user_ids: string[] };
  validatePortalContext(pending.portal, false);
  if (!Array.isArray(pending.user_ids)
    || (!pending.user_ids.includes(actor.user_id) && req.explicit_link !== true)) throw AppError.forbidden();
  const mappedTenant = await resolvePortalTenant(state.sql, pending.portal, false);
  if (!mappedTenant || actor.tenant_id !== mappedTenant) throw AppError.forbidden();
  const membership = await state.sql`
    SELECT t.id FROM tenant_member tm JOIN tenant t ON t.id = tm.tenant_id
    WHERE tm.user_id = ${actor.user_id} AND tm.status = 'active' AND t.status = 'active'
      AND tm.tenant_id = ${actor.tenant_id}
      AND t.id = ${mappedTenant}
    LIMIT 1
  `;
  if (!membership.length) throw AppError.forbidden();
  if (!await state.redis.del(key)) throw AppError.unauthorized();
  const provisioned = await provisionPortalActor(
    state, pending.portal, mapDocumindRoles(pending.portal), actor);
  const sessionId = await createAuthSession(state.redis, state.config, provisioned.actor, 'portal');
  return c.json({ auth: portalAuth(await issueToken(state.config, provisioned.actor, sessionId,
    provisioned.effective_permissions), provisioned.actor), redirect: AUTHENTICATED_HOME_PATH });
}
async function portalCreateHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  if ((!state.config.portalAuthEnabled && state.config.authLoginMode !== 'portal') || !state.sql || !state.redis) throw AppError.unauthorized();
  const req = await c.req.json() as { challenge?: string };
  if (!req.challenge || !/^[0-9a-f-]{36}$/i.test(req.challenge)) throw AppError.unauthorized();
  const key = `documind:portal:link:${req.challenge}`;
  const raw = await state.redis.get(key);
  if (!raw) throw AppError.unauthorized();
  const pending = JSON.parse(raw) as { portal: PortalContext; user_ids: string[] };
  validatePortalContext(pending.portal, false);
  if (!Array.isArray(pending.user_ids) || pending.user_ids.length) throw AppError.forbidden();
  const mappedTenant = await resolvePortalTenant(state.sql, pending.portal, false);
  if (!mappedTenant) throw AppError.forbidden();
  const mapping = await state.sql`
    SELECT origin FROM portal_tenant_mapping
    WHERE portal_tenant_id = ${pending.portal.tenant_id} AND tenant_id = ${mappedTenant}
  `;
  if (mapping[0]?.origin !== 'approved') throw AppError.forbidden();
  if (!await state.redis.del(key)) throw AppError.unauthorized();
  return finishPortalLogin(state, pending.portal, mapDocumindRoles(pending.portal), true);
}


async function finishPortalLogin(
  state: AppState, portal: PortalContext, roles: string[], json = false,
): Promise<Response> {
  const provisioned = await provisionPortalActor(state, portal, roles);
  const sessionId = await createAuthSession(state.redis, state.config, provisioned.actor, 'portal');
  const token = await issueToken(state.config, provisioned.actor, sessionId, provisioned.effective_permissions);
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
  if (!json) return portalSuccessHtml(token, provisioned.actor);
  const me = await meResponse(state, provisioned.actor);
  const body: LoginResponse = {
    access_token: token, token_type: 'bearer', scope: me.scope,
    user: me.user, tenant: me.tenant, roles: me.roles,
    permissions: me.permissions, allowed_kb_ids: me.allowed_kb_ids,
    tenants: [me.tenant],
  };
  return new Response(JSON.stringify(body), { status: 200, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  } });
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

export async function provisionPortalActor(
  state: AppState, portal: PortalContext, roles: string[], linkActor?: CurrentActor,
): Promise<PortalProvisionResult> {
  const sql = state.sql;
  if (!sql) {
    throw AppError.badRequest('PORTAL_REQUIRES_DB', 'database is required for portal managed auth');
  }
  const tenantId = await resolvePortalTenant(sql, portal, true);
  if (!tenantId) throw AppError.forbidden();

  const { email, identityCreated, userId, effectiveRoles, effectivePermissions, wasClamped } =
    await sql.begin(async (tx) => {
  const email = portal.email?.trim() || null;
  const existingPortal = await tx`
    SELECT pim.local_user_id AS id, u.status
    FROM portal_identity_mapping pim
    JOIN app_user u ON u.id = pim.local_user_id
    WHERE pim.portal_user_id = ${portal.user_id} AND pim.portal_tenant_id = ${portal.tenant_id}
      AND pim.local_tenant_id = ${tenantId}
  `;
  if (existingPortal[0]?.status && existingPortal[0].status !== 'active') throw AppError.forbidden();
  if (linkActor && existingPortal.length && String(existingPortal[0]!.id) !== linkActor.user_id) {
    throw AppError.forbidden();
  }
  const identityCreated = existingPortal.length === 0 && !linkActor;
  const userId = existingPortal[0] ? String(existingPortal[0].id) : linkActor?.user_id ?? newUuid();
  if (linkActor && !existingPortal.length) {
    const linked = await tx`
      INSERT INTO portal_identity_mapping
        (portal_user_id, portal_tenant_id, local_user_id, local_tenant_id)
      VALUES (${portal.user_id}, ${portal.tenant_id}, ${linkActor.user_id}, ${tenantId})
      ON CONFLICT DO NOTHING RETURNING local_user_id
    `;
    if (!linked.length) throw AppError.forbidden();
  }
  const membership = await tx`
    SELECT roles, attributes FROM tenant_member
    WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND status = 'active'
  `;
  const mapped = await tx`
    SELECT origin FROM portal_tenant_mapping
    WHERE portal_tenant_id = ${portal.tenant_id} AND tenant_id = ${tenantId}
  `;
  if (!mapped.length) throw AppError.forbidden();
  if (!identityCreated && !membership.length && mapped[0]!.origin === 'approved') {
    throw AppError.forbidden();
  }
  const effectiveRoles = portalMembershipRoles(roles, String(mapped[0]!.origin),
    membership[0]?.roles as string[] | undefined,
    (membership[0]?.attributes as { auth_provider?: string } | undefined)?.auth_provider === 'portal');
  const localPermissions = derivePermissions(effectiveRoles);
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
  if (identityCreated) {
    const occupiedEmail = email ? await tx`
      SELECT id FROM app_user WHERE lower(email) = lower(${email}) LIMIT 1
    ` : [];
    await tx`
      INSERT INTO app_user
        (id, login_id, email, name, auth_provider, last_active_tenant, status)
      VALUES (${userId}, ${`portal-${portal.user_id}-${portal.tenant_id}`},
        ${occupiedEmail.length ? null : email}, ${portal.display_name},
        'portal', ${tenantId}, 'active')
    `;
    const linked = await tx`
      INSERT INTO portal_identity_mapping
        (portal_user_id, portal_tenant_id, local_user_id, local_tenant_id)
      VALUES (${portal.user_id}, ${portal.tenant_id}, ${userId}, ${tenantId})
      ON CONFLICT DO NOTHING RETURNING local_user_id
    `;
    if (!linked.length) throw AppError.forbidden();
  } else {
    await tx`
      UPDATE app_user SET name = ${portal.display_name}, last_active_tenant = ${tenantId},
        updated_at = NOW() WHERE id = ${userId} AND status = 'active'
    `;
  }


  await tx`
    INSERT INTO tenant_member (tenant_id, user_id, roles, attributes, status, joined_at, last_seen_at)
    VALUES (${tenantId}, ${userId}, ${effectiveRoles}, ${tx.json(attributes)}, 'active', NOW(), NOW())
    ON CONFLICT (tenant_id, user_id) DO UPDATE
    SET roles = CASE WHEN ${String(mapped[0]!.origin)} = 'portal_created'
      AND tenant_member.attributes->>'auth_provider' = 'portal'
      AND NOT ('tenant_owner' = ANY(tenant_member.roles))
      THEN EXCLUDED.roles ELSE tenant_member.roles END,
      attributes = EXCLUDED.attributes, last_seen_at = NOW()
    WHERE tenant_member.status = 'active'
  `;
  if (linkActor) {
    await recordAuditEvent(tx, linkActor, 'portal.identity.link.verified',
      'portal_identity_mapping', userId, {
        portal_user_id: portal.user_id, portal_tenant_id: portal.tenant_id,
        local_user_id: userId, local_tenant_id: tenantId,
      });
  }
  return { email, identityCreated, userId, effectiveRoles, effectivePermissions, wasClamped };
  });

  const claims: Claims = {
    sub: userId, email: email ?? '', role: effectiveRoles[0]!,
    scope: 'tenant',
    tenant_id: tenantId, sid: null,
    exp: Math.floor(Date.now() / 1000) + 3600,
    auth_source: 'portal', portal_permissions: effectivePermissions,
  };
  const actor = await actorFromClaims({ sql, config: state.config }, claims);
  return { actor, identity_created: identityCreated, was_clamped: wasClamped, effective_permissions: effectivePermissions };
}

export function portalMembershipRoles(
  systemRoles: string[], mappingOrigin: string, localRoles?: string[], portalManaged = false,
): string[] {
  const locallyApproved = (mappingOrigin === 'portal_created' && (!localRoles || portalManaged))
    || !!localRoles?.some((role) => role === 'tenant_owner' || role === 'tenant_admin');
  return systemRoles.includes('tenant_admin') && locallyApproved ? ['tenant_admin'] : ['end_user'];
}

export function mapDocumindRoles(portal: PortalContext): string[] {
  const roles = (portal.system_roles ?? []).map(mapDocumindRole);
  if (!roles.length || roles.includes(null)) throw AppError.unauthorized();
  return sortDocumindRolesByPriority(roles as string[]);
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
    case 'tenant_owner': case 'tenant_admin': return 'tenant_admin';
    case 'user': return 'end_user';
    default: return null;
  }
}


function sortDocumindRolesByPriority(roles: string[]): string[] {
  const priority = ['tenant_admin', 'end_user'];
  return priority.filter((role) => roles.includes(role));
}

function portalAuth(token: string, actor: CurrentActor) {
  return {
    token, userId: actor.user_id, tenantId: actor.tenant_id,
    loginId: actor.login_id, email: actor.email, scope: actor.scope, roles: actor.roles,
  };
}

function portalSuccessHtml(token: string, actor: CurrentActor): Response {
  const auth = portalAuth(token, actor);
  const target = AUTHENTICATED_HOME_PATH;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>DocuMind 登录中</title></head>
<body>
<script>
const auth = ${JSON.stringify(auth).replace(/</g, '\\u003c')};
const prefix = window.location.pathname.startsWith("/documind/") || window.location.pathname === "/documind" ? "/documind" : "";
const target = ${JSON.stringify(target)};
localStorage.setItem("documind-auth", JSON.stringify(auth));
window.location.replace(prefix + target);
</script>
</body></html>`;
  return new Response(html, { status: 200, headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  } });
}

function portalLinkHtml(challenge: string, allowCreate = false): Response {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>关联 DocuMind 账号</title></head>
<body><main><h1>关联已有 DocuMind 账号</h1>
<p>请在另一个标签页登录已有账号并切换到对应企业；返回本页后点击关联。链接将在五分钟内失效。</p>
<a id="login" target="_blank" rel="noopener noreferrer">打开 DocuMind 登录页</a>
<button type="button" id="link">验证本地登录并关联</button>
${allowCreate ? '<button type="button" id="create">确认无历史账号，创建新账号</button>' : ''}
<p id="status" role="status"></p></main>
<script>
const prefix = location.pathname.startsWith("/documind/") ? "/documind" : "";
document.getElementById("login").href = prefix + "/login";
document.getElementById("link").onclick = async () => {
  const status = document.getElementById("status");
  const stored = JSON.parse(localStorage.getItem("documind-auth") || "null");
  if (!stored?.token) { status.textContent = "请先在另一个标签页登录 DocuMind"; return; }
  try {
    const response = await fetch(prefix + "/api/auth/portal/link", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + stored.token },
      body: JSON.stringify({ challenge: ${JSON.stringify(challenge)}, explicit_link: true })
    });
    if (!response.ok) throw new Error("关联失败：请确认本地账号属于当前企业，或重新从门户进入");
    const data = await response.json();
    localStorage.setItem("documind-auth", JSON.stringify(data.auth));
    location.replace(prefix + data.redirect);
  } catch (error) { status.textContent = error.message; }
};
if (${JSON.stringify(allowCreate)}) document.getElementById("create").onclick = async () => {
  const status = document.getElementById("status");
  try {
    const response = await fetch(prefix + "/api/auth/portal/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge: ${JSON.stringify(challenge)} })
    });
    if (!response.ok) throw new Error("创建失败：请重新从门户进入");
    const data = await response.json();
    localStorage.setItem("documind-auth", JSON.stringify({
      token: data.access_token, userId: data.user.id, tenantId: data.tenant.id,
      loginId: data.user.login_id, email: data.user.email, scope: data.scope, roles: data.roles
    }));
    location.replace(prefix + ${JSON.stringify(AUTHENTICATED_HOME_PATH)});
  } catch (error) { status.textContent = error.message; }
};
</script></body></html>`;
  return new Response(html, { status: 200, headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  } });
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
  if (claims.auth_source === 'portal'
    || (state.config.authLoginMode === 'portal' && !claims.auth_source)) throw AppError.forbidden();
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
  if (claims.auth_source === 'portal'
    || (state.config.authLoginMode === 'portal' && !claims.auth_source)) throw AppError.forbidden();
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
  if (claims.auth_source === 'portal') throw AppError.unauthorized();
  if (state.config.authLoginMode === 'portal' && !claims.auth_source) throw AppError.unauthorized();
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

async function validateInvitationHandler(c: import('hono').Context<AppEnv>) {
  const sql = c.get('appState').sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '邀请功能需要数据库');
  const req = await c.req.json() as AcceptInvitationRequest;
  const token = (req.token ?? '').trim();
  if (!token) throw AppError.badRequest('INVITATION_TOKEN_REQUIRED', '邀请链接无效');
  const rows = await sql`
    SELECT inv.id, inv.kind, inv.invitee_username_normalized, inv.roles, inv.status,
           inv.expires_at, t.id AS tenant_id, t.name AS tenant_name, t.status AS tenant_status
    FROM tenant_invitation inv
    JOIN tenant t ON t.id = inv.tenant_id
    WHERE inv.token_hash = ${invitationTokenHash(token)}
    LIMIT 1
  `;
  const invitation = rows[0];
  if (!invitation || invitation.status !== 'pending'
    || new Date(invitation.expires_at as Date | string).getTime() <= Date.now()) {
    return c.json({ valid: false, code: 'invite_invalid_or_expired' });
  }
  return c.json({
    valid: true,
    tenant: { name: String(invitation.tenant_name) },
    kind: String(invitation.kind),
    invitee_hint: maskInvitationAccount(
      invitation.invitee_username_normalized === null
        ? null
        : String(invitation.invitee_username_normalized),
    ),
    roles: Array.isArray(invitation.roles) ? invitation.roles : [],
    expires_at: new Date(invitation.expires_at as Date | string).toISOString(),
  });
}

function maskInvitationAccount(value: string | null): string | null {
  if (value === null) return null;
  const [name, domain] = value.split('@');
  if (domain) return `${name?.slice(0, 1) ?? ''}***@${domain}`;
  return `${value.slice(0, 1)}***`;
}

async function acceptInvitationHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '邀请功能需要数据库');
  const req = await c.req.json() as AcceptInvitationRequest;
  const token = (req.token ?? '').trim();
  if (!token) throw AppError.badRequest('INVITATION_TOKEN_REQUIRED', '邀请链接无效');
  const claims = await claimsFromAuthorizationHeader(
    state.config, c.req.header('authorization') ?? null);
  await validateAndRenewAuthSession(state.redis, state.config, claims);
  if (claims.auth_source === 'portal'
    || (state.config.authLoginMode === 'portal' && !claims.auth_source)) throw AppError.forbidden();
  const result = await sql.begin(async (tx) => {
    const accounts = await tx`
      SELECT login_id, status FROM app_user WHERE id = ${claims.sub} FOR UPDATE
    `;
    const account = accounts[0];
    if (!account || account.status !== 'active') {
      throw AppError.forbiddenWith('ACCOUNT_NOT_ACTIVE', '账号已停用，不能接受邀请');
    }
    const rows = await tx`
      SELECT inv.id, inv.tenant_id, inv.kind, inv.invitee_username_normalized,
             inv.roles, inv.kb_grants, inv.invited_by, inv.status, inv.accepted_by,
             inv.expires_at, t.status AS tenant_status
      FROM tenant_invitation inv
      JOIN tenant t ON t.id = inv.tenant_id
      WHERE inv.token_hash = ${invitationTokenHash(token)}
      LIMIT 1
      FOR UPDATE OF inv, t
    `;
    const invitation = rows[0];
    if (!invitation) throw AppError.notFound('INVITATION_NOT_FOUND', '邀请不存在或已失效');
    const tenantId = String(invitation.tenant_id);
    if (invitation.status === 'accepted' && String(invitation.accepted_by) === claims.sub) {
      return {
        tenantId,
        roles: normalizeInvitationRoles(invitation.roles, String(invitation.kind)),
        alreadyAccepted: true,
      };
    }
    if (invitation.status !== 'pending'
      || new Date(invitation.expires_at as Date | string).getTime() <= Date.now()) {
      throw AppError.notFound('INVITATION_NOT_FOUND', '邀请不存在或已失效');
    }
    const kind = String(invitation.kind);
    const invitee = invitation.invitee_username_normalized === null
      ? null
      : String(invitation.invitee_username_normalized);
    if (kind === 'targeted' && invitee !== normalizeInvitationAccount(String(account.login_id))) {
      throw AppError.forbiddenWith('INVITATION_ACCOUNT_MISMATCH', '该邀请不属于当前账号');
    }
    const roles = normalizeInvitationRoles(invitation.roles, kind);
    const tenantStatus = String(invitation.tenant_status);
    if (tenantStatus !== 'active' && !(kind === 'bootstrap_owner' && tenantStatus === 'pending')) {
      throw AppError.conflictWith('TENANT_NOT_ACTIVE', '租户当前不可接受邀请');
    }
    const memberships = await tx`
      SELECT status FROM tenant_member
      WHERE tenant_id = ${tenantId} AND user_id = ${claims.sub}
      FOR UPDATE
    `;
    if (memberships[0]) {
      const status = String(memberships[0].status);
      throw AppError.conflictWith(
        status === 'active' ? 'INVITEE_ALREADY_MEMBER' : 'INVITEE_MEMBERSHIP_BLOCKED',
        status === 'active' ? '当前账号已是该租户成员' : '当前成员状态不可通过邀请恢复',
      );
    }
    await tx`
      INSERT INTO tenant_member (tenant_id, user_id, roles, status, invited_by, invited_at, joined_at)
      VALUES (
        ${tenantId}, ${claims.sub}, ${roles}, 'active',
        ${String(invitation.invited_by)}, NOW(), NOW()
      )
    `;
    const grantsValue = invitation.kb_grants;
    const grants = Array.isArray(grantsValue) ? grantsValue as InvitationGrantStored[] : [];
    for (const grant of grants) {
      if (!grant.kb_id || !['query', 'edit', 'manage'].includes(grant.permission)) {
        throw AppError.forbiddenWith('INVITATION_KB_GRANT_INVALID', '邀请中的知识库授权无效');
      }
      const knowledgeBases = await tx`
        SELECT 1 FROM knowledge_base
        WHERE id = ${grant.kb_id} AND tenant_id = ${tenantId}
        LIMIT 1
      `;
      if (!knowledgeBases[0]) {
        throw AppError.forbiddenWith('INVITATION_KB_GRANT_INVALID', '邀请中的知识库授权无效');
      }
      await tx`
        INSERT INTO knowledge_base_acl
          (tenant_id, kb_id, subject_type, subject_id, permission, created_by)
        VALUES (${tenantId}, ${grant.kb_id}, 'user', ${claims.sub}, ${grant.permission}, NULL)
        ON CONFLICT (tenant_id, kb_id, subject_type, subject_id, permission) DO NOTHING
      `;
    }
    await tx`
      UPDATE tenant_invitation
      SET status = 'accepted', accepted_by = ${claims.sub}, accepted_at = NOW(), updated_at = NOW()
      WHERE id = ${String(invitation.id)}
    `;
    if (kind === 'bootstrap_owner') {
      await tx`
        UPDATE tenant SET status = 'active', updated_at = NOW()
        WHERE id = ${tenantId} AND status = 'pending'
      `;
    }
    await tx`
      UPDATE app_user SET last_active_tenant = ${tenantId}, updated_at = NOW()
      WHERE id = ${claims.sub}
    `;
    await tx`
      INSERT INTO audit_log
        (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
      VALUES (
        ${tenantId}, ${claims.sub}, ${roles[0]!}, 'tenant_invitation.accept',
        'tenant_invitation', ${String(invitation.id)},
        ${tx.json({ login_id: String(account.login_id), roles })}
      )
    `;
    return { tenantId, roles, alreadyAccepted: false };
  });
  const actor = await actorFromClaims({ sql, config: state.config }, {
    ...claims,
    tenant_id: result.tenantId,
    role: result.roles[0] ?? 'end_user',
    scope: 'tenant',
  });
  const sessionId = claims.sid ?? await createAuthSession(state.redis, state.config, actor);
  await setAuthSessionTenant(
    state.redis, state.config, sessionId, actor.user_id,
    result.tenantId, actor.roles[0] ?? 'end_user');
  return c.json({
    ...await tenantLoginResponse(state, actor, sessionId),
    already_accepted: result.alreadyAccepted,
  });
}

function normalizeInvitationRoles(value: unknown, kind: string): string[] {
  const source = Array.isArray(value) ? value.map(String) : [];
  const roles = [...new Set(source)];
  const allowed: Record<string, true> = kind === 'bootstrap_owner'
    ? { tenant_owner: true }
    : { tenant_admin: true, end_user: true };
  if (!roles.length || roles.some((role) => !allowed[role])) {
    throw AppError.forbiddenWith('INVITATION_ROLE_FORBIDDEN', '邀请角色无效或无权授予');
  }
  return roles;
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
