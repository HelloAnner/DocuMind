// 移植自 apps/api-rs/src/api/admin_members.rs
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { TransactionSql } from 'postgres';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import { recordAuditEvent } from '../auth/audit.ts';
import { requirePermission, requireTenantAdmin } from '../auth/permissions.ts';
import { toRfc3339 } from '../infra/time.ts';

interface UpdateMemberRequest { role?: string | null; status?: string | null; }

export function adminMembersRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.patch('/api/admin/members/:user_id', updateMember);
  router.delete('/api/admin/members/:user_id', removeMember);
  return router;
}

async function updateMember(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'member.write');
  const req = await c.req.json() as UpdateMemberRequest;
  if (req.role == null && req.status == null) {
    throw AppError.badRequest('MEMBER_UPDATE_EMPTY', '请至少修改角色或状态');
  }
  const role = req.role != null ? normalizeMemberRole(req.role) : null;
  const status = req.status != null ? normalizeMemberStatus(req.status) : null;
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '成员管理功能需要数据库');
  const userId = c.req.param('user_id')!;

  const updated = await sql.begin(async (tx) => {
    await lockTenantMembers(tx, actor.tenant_id);
    const memberships = await tx`
      SELECT roles, status FROM tenant_member
      WHERE tenant_id = ${actor.tenant_id} AND user_id = ${userId}
      LIMIT 1 FOR UPDATE
    `;
    const membership = memberships[0];
    if (!membership) throw memberNotFound();
    const currentRoles = (membership.roles as string[]) ?? [];
    const currentStatus = String(membership.status);
    const currentlyActiveAdmin = currentStatus === 'active'
      && currentRoles.some((item) => item === 'tenant_admin');
    const effectiveStatus = status ?? currentStatus;
    const effectiveRole = role ?? (currentRoles.some((item) => item === 'tenant_admin')
      ? 'tenant_admin' : 'end_user');
    const remainsActiveAdmin = effectiveStatus === 'active' && effectiveRole === 'tenant_admin';
    if (currentlyActiveAdmin && !remainsActiveAdmin) {
      await ensureOtherActiveAdmin(tx, actor.tenant_id, userId);
    }
    const rows = await tx`
      UPDATE tenant_member
      SET roles = CASE WHEN ${role}::text IS NULL THEN roles ELSE ARRAY[${role}::text] END,
          status = COALESCE(${status}, status),
          updated_at = NOW()
      WHERE tenant_id = ${actor.tenant_id} AND user_id = ${userId}
      RETURNING roles, status, joined_at, last_seen_at
    `;
    const row = rows[0];
    if (!row) throw memberNotFound();
    return row;
  });

  const roles = (updated.roles as string[]) ?? [];
  const statusValue = String(updated.status);
  await recordAuditEvent(sql, actor, 'tenant_member.update', 'tenant_member', userId, {
    roles, status: statusValue,
  });
  return c.json({
    user_id: userId,
    roles,
    status: statusValue,
    joined_at: optionalRfc3339(updated.joined_at),
    last_seen_at: optionalRfc3339(updated.last_seen_at),
  });
}

async function removeMember(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'member.delete');
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '成员管理功能需要数据库');
  const userId = c.req.param('user_id')!;

  const roles = await sql.begin(async (tx) => {
    await lockTenantMembers(tx, actor.tenant_id);
    const memberships = await tx`
      SELECT roles, status FROM tenant_member
      WHERE tenant_id = ${actor.tenant_id} AND user_id = ${userId}
      LIMIT 1 FOR UPDATE
    `;
    const membership = memberships[0];
    if (!membership) throw memberNotFound();
    const currentRoles = (membership.roles as string[]) ?? [];
    const currentStatus = String(membership.status);
    if (currentStatus === 'active' && currentRoles.some((item) => item === 'tenant_admin')) {
      await ensureOtherActiveAdmin(tx, actor.tenant_id, userId);
    }
    await tx`
      UPDATE tenant_member SET status = 'removed', updated_at = NOW()
      WHERE tenant_id = ${actor.tenant_id} AND user_id = ${userId}
    `;
    await tx`
      DELETE FROM knowledge_base_acl
      WHERE tenant_id = ${actor.tenant_id} AND subject_type = 'user' AND subject_id = ${userId}
    `;
    return currentRoles;
  });

  await recordAuditEvent(sql, actor, 'tenant_member.remove', 'tenant_member', userId, {
    previous_roles: roles,
  });
  return c.json({ user_id: userId, status: 'removed' });
}

export function normalizeMemberRole(value: string): string {
  switch (value.trim()) {
    case 'tenant_admin': return 'tenant_admin';
    case 'end_user': case 'user': case 'analyst': case 'viewer': return 'end_user';
    case 'super_admin':
      throw AppError.forbiddenWith('MEMBER_ROLE_FORBIDDEN', '租户管理员不能授予超级管理员角色');
    default:
      throw AppError.badRequest('MEMBER_ROLE_INVALID', '成员角色只能是 tenant_admin 或 end_user');
  }
}

export function normalizeMemberStatus(value: string): string {
  const status = value.trim();
  if (status === 'active' || status === 'suspended') return status;
  throw AppError.badRequest('MEMBER_STATUS_INVALID', '成员状态只能是 active 或 suspended');
}

async function lockTenantMembers(tx: TransactionSql, tenantId: string): Promise<void> {
  const rows = await tx`
    SELECT id FROM tenant WHERE id = ${tenantId} FOR UPDATE
  `;
  if (rows.length === 0) throw AppError.internal('tenant not found while locking members');
}

async function ensureOtherActiveAdmin(
  tx: TransactionSql, tenantId: string, userId: string,
): Promise<void> {
  const rows = await tx`
    SELECT COUNT(*) AS count
    FROM tenant_member
    WHERE tenant_id = ${tenantId}
      AND user_id <> ${userId}
      AND status = 'active'
      AND 'tenant_admin' = ANY(roles)
  `;
  if (Number(rows[0]?.count ?? 0) === 0) {
    throw AppError.conflictWith('LAST_TENANT_ADMIN', '租户必须至少保留一位启用中的租户管理员');
  }
}

function optionalRfc3339(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toRfc3339(new Date(value as Date | string));
}

function memberNotFound(): AppError {
  return AppError.notFound('TENANT_MEMBER_NOT_FOUND', '当前租户中不存在该成员');
}
