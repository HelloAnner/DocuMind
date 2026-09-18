// 移植自 apps/api-rs/src/auth.rs 的数据库身份解析与认证
import bcrypt from 'bcryptjs';
import type { Sql } from 'postgres';
import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import type { CurrentActor } from '../models/identity.ts';
import type { Claims } from './jwt.ts';
import {
  effectivePermissionsForMembership, isDocumindAdmin, normalizedActorRoles,
} from './permissions.ts';

interface ActorDeps {
  sql: Sql | null;
  config: AppConfig;
}

async function platformAdminActive(sql: Sql, userId: string): Promise<boolean> {
  const rows = await sql`
    SELECT EXISTS (SELECT 1 FROM platform_admin WHERE user_id = ${userId} AND status = 'active') AS active
  `;
  return Boolean(rows[0]?.active);
}

async function allowedKbIds(sql: Sql, tenantId: string, userId: string, roles: string[]): Promise<string[]> {
  if (isDocumindAdmin(roles)) {
    const rows = await sql`
      SELECT id FROM knowledge_base WHERE tenant_id = ${tenantId} AND status = 'active'
    `;
    return rows.map((row) => String(row.id));
  }
  const rows = await sql`
    SELECT DISTINCT kb_id
    FROM knowledge_base_acl
    WHERE tenant_id = ${tenantId}
      AND permission IN ('read', 'write', 'manage')
      AND (
        (subject_type = 'role' AND subject_id = ANY(${roles}))
        OR (subject_type = 'user' AND subject_id = ${userId})
      )
  `;
  return rows.map((row) => String(row.kb_id));
}

function buildActorFromFallback(
  tenantId: string, userId: string, email: string, name: string, role: string,
  defaultKbIds: string[],
): CurrentActor {
  const includeSuperAdmin = role === 'super_admin';
  const roles = normalizedActorRoles([role], includeSuperAdmin);
  return {
    user_id: userId, tenant_id: tenantId, login_id: email, email, name,
    scope: includeSuperAdmin ? 'platform' : 'tenant',
    roles,
    permissions: derivePermissionsCached(roles),
    allowed_kb_ids: defaultKbIds,
    is_super_admin: includeSuperAdmin,
    api_client_id: null, api_token_id: null, api_scopes: [], api_token_expires_at: null,
  };
}

// 避免循环 import：permissions.derivePermissions 的本地 re-export
import { derivePermissions } from './permissions.ts';
function derivePermissionsCached(roles: string[]): string[] { return derivePermissions(roles); }

export async function resolveActorFromDb(
  sql: Sql, tenantId: string, userId: string, requestedRole: string, requestedScope: string,
): Promise<CurrentActor> {
  const users = await sql`
    SELECT id, login_id, email, name, status FROM app_user WHERE id = ${userId}
  `;
  const user = users[0];
  if (!user) throw AppError.unauthorized();
  if (user.status !== 'active') throw AppError.unauthorized();

  const isPlatformAdmin = await platformAdminActive(sql, userId);
  const includeSuperAdmin = requestedScope === 'platform' && requestedRole === 'super_admin';
  const isSuperAdmin = isPlatformAdmin && includeSuperAdmin;
  const memberships = await sql`
    SELECT tm.roles, tm.attributes
    FROM tenant_member tm
    JOIN tenant t ON t.id = tm.tenant_id
    WHERE tm.tenant_id = ${tenantId}
      AND tm.user_id = ${userId}
      AND tm.status = 'active'
      AND (t.status = 'active' OR ${isSuperAdmin})
    LIMIT 1
  `;
  const membership = memberships[0];
  if (!membership) throw AppError.unauthorized();
  const membershipRoles = (membership.roles as string[]) ?? [];
  const roles = normalizedActorRoles(membershipRoles, isSuperAdmin);
  const attributes = membership.attributes ?? {};
  if (roles.length === 0) throw AppError.unauthorized();

  const kbIds = await allowedKbIds(sql, tenantId, userId, roles);
  const permissions = effectivePermissionsForMembership(roles, attributes);
  const loginId = String(user.login_id);
  return {
    user_id: userId, tenant_id: tenantId, login_id: loginId,
    email: (user.email as string | null) ?? '',
    name: (user.name as string | null) ?? loginId,
    scope: isSuperAdmin ? 'platform' : 'tenant',
    roles, permissions, allowed_kb_ids: kbIds, is_super_admin: isSuperAdmin,
    api_client_id: null, api_token_id: null, api_scopes: [], api_token_expires_at: null,
  };
}

export async function authenticateFromDb(
  sql: Sql, username: string, password: string, tenantKey: string | null,
): Promise<CurrentActor> {
  const users = await sql`
    SELECT id, login_id, email, name, password_hash, status
    FROM app_user WHERE lower(login_id) = lower(${username}) LIMIT 1
  `;
  const user = users[0];
  if (!user) throw AppError.unauthorized();
  if (user.status !== 'active') throw AppError.unauthorized();
  const passwordHash = (user.password_hash as string | null) ?? '';
  if (!passwordHash) throw AppError.unauthorized();
  const ok = await bcrypt.compare(password, passwordHash);
  if (!ok) throw AppError.unauthorized();

  const userId = String(user.id);
  const isPlatformAdmin = await platformAdminActive(sql, userId);
  let membership;
  if (tenantKey && tenantKey.trim().length > 0) {
    const rows = await sql`
      SELECT tm.tenant_id, tm.roles, tm.attributes, t.name, t.slug, t.plan, t.status
      FROM tenant_member tm
      JOIN tenant t ON t.id = tm.tenant_id
      WHERE tm.user_id = ${userId}
        AND tm.status = 'active'
        AND t.status = 'active'
        AND (tm.tenant_id::text = ${tenantKey} OR t.slug = ${tenantKey})
      LIMIT 1
    `;
    membership = rows[0];
  } else {
    const rows = await sql`
      SELECT tm.tenant_id, tm.roles, tm.attributes, t.name, t.slug, t.plan, t.status
      FROM tenant_member tm
      JOIN tenant t ON t.id = tm.tenant_id
      WHERE tm.user_id = ${userId}
        AND tm.status = 'active'
        AND (
          t.status = 'active'
          OR EXISTS (
            SELECT 1 FROM platform_admin pa
            WHERE pa.user_id = tm.user_id AND pa.status = 'active'
          )
        )
      ORDER BY
        CASE
          WHEN EXISTS (
            SELECT 1 FROM platform_admin pa
            WHERE pa.user_id = tm.user_id AND pa.status = 'active'
          ) THEN 0
          WHEN tm.tenant_id = (
            SELECT last_active_tenant FROM app_user WHERE id = tm.user_id
          ) THEN 1
          WHEN 'tenant_admin' = ANY(tm.roles) THEN 2
          ELSE 3
        END,
        tm.joined_at DESC NULLS LAST
      LIMIT 1
    `;
    membership = rows[0];
  }
  if (!membership) throw AppError.unauthorized();

  const tenantId = String(membership.tenant_id);
  const membershipRoles = (membership.roles as string[]) ?? [];
  const explicitTenant = tenantKey !== null && tenantKey.trim().length > 0;
  const includeSuperAdmin = !explicitTenant;
  const isSuperAdmin = isPlatformAdmin && includeSuperAdmin;
  const roles = normalizedActorRoles(membershipRoles, isSuperAdmin);
  const attributes = membership.attributes ?? {};
  if (roles.length === 0) {
    if (isPlatformAdmin && explicitTenant) {
      throw AppError.forbiddenWith(
        'PLATFORM_ADMIN_TENANT_MEMBERSHIP_REQUIRED', '该平台账号未被授予当前租户成员身份');
    }
    throw AppError.unauthorized();
  }
  const kbIds = await allowedKbIds(sql, tenantId, userId, roles);
  const permissions = effectivePermissionsForMembership(roles, attributes);
  const loginId = String(user.login_id);
  const email = (user.email as string | null) ?? '';
  const name = (user.name as string | null) ?? loginId;
  const actor: CurrentActor = {
    user_id: userId, tenant_id: tenantId, login_id: loginId, email, name,
    scope: isSuperAdmin ? 'platform' : 'tenant',
    roles, permissions, allowed_kb_ids: kbIds, is_super_admin: isSuperAdmin,
    api_client_id: null, api_token_id: null, api_scopes: [], api_token_expires_at: null,
  };
  await sql`
    UPDATE tenant_member SET last_seen_at = NOW(), updated_at = NOW()
    WHERE tenant_id = ${tenantId} AND user_id = ${userId}
  `;
  if (!isSuperAdmin) {
    await sql`
      UPDATE app_user SET last_active_tenant = ${tenantId}, updated_at = NOW() WHERE id = ${userId}
    `;
  }
  return actor;
}

export function authenticateFromConfig(
  config: AppConfig, username: string, password: string,
): CurrentActor {
  const accounts: Array<[string, string, string, string, string]> = [
    [config.superAdminEmail, config.superAdminPassword, config.superAdminUserId, 'super_admin', 'Ops Super Admin'],
    [config.enterpriseAdminEmail, config.enterpriseAdminPassword, config.defaultUserId, 'enterprise_admin', 'Enterprise Admin'],
    [config.standardUserEmail, config.standardUserPassword, config.standardUserId, 'user', 'DocuMind User'],
  ];
  const account = accounts.find(([email, expected]) =>
    email.toLowerCase() === username.toLowerCase() && password === expected);
  if (!account) throw AppError.unauthorized();
  return buildActorFromFallback(
    config.defaultTenantId, account[2], account[0], account[4], account[3], config.defaultKbIds);
}

export async function authenticate(
  deps: ActorDeps, username: string, password: string, tenantKey: string | null,
): Promise<CurrentActor> {
  if (username.trim().length === 0 || password.length === 0) {
    throw AppError.badRequest('CREDENTIALS_REQUIRED', '请输入用户 ID 和密码');
  }
  if (deps.sql) {
    return authenticateFromDb(deps.sql, username.trim(), password, tenantKey);
  }
  return authenticateFromConfig(deps.config, username.trim(), password);
}

export async function actorFromClaims(
  deps: ActorDeps, claims: Claims,
): Promise<CurrentActor> {
  if (!claims.tenant_id) {
    throw AppError.conflictWith('TENANT_SELECTION_REQUIRED', '请先选择或创建租户');
  }
  if (deps.sql) {
    return resolveActorFromDb(deps.sql, claims.tenant_id, claims.sub, claims.role, claims.scope);
  }
  return buildActorFromFallback(
    claims.tenant_id, claims.sub, claims.email, claims.email, claims.role,
    deps.config.defaultKbIds);
}

export type { ActorDeps };
