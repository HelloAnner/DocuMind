// 移植自 apps/api-rs/src/api/admin.rs 的 invitations 部分
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { JSONValue, Sql } from 'postgres';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import { recordAuditEvent } from '../auth/audit.ts';
import { requirePermission, requireTenantAdmin } from '../auth/permissions.ts';
import { toRfc3339 } from '../infra/time.ts';
import { clampDays, invitationTokenHash, newInvitationToken } from './system_tenants.ts';
import { ensureKbExists, normalizeAclPermission } from './admin_support.ts';

interface InvitationGrantRequest { kb_id: string; permission: string; }
interface InvitationCreateRequest {
  email: string;
  name?: string | null;
  roles: string[];
  kb_grants?: InvitationGrantRequest[] | null;
  expires_in_days?: number | null;
}
interface InvitationGrant { kb_id: string; permission: string; }

export interface TenantInvitationSummary {
  id: string;
  tenant_id: string;
  email: string | null;
  name: string | null;
  roles: string[];
  kb_grants: unknown;
  status: string;
  invited_by: string;
  invited_by_label: string | null;
  accepted_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  invite_url: string | null;
}

export function adminInvitationsRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/admin/invitations', listInvitations);
  router.post('/api/admin/invitations', createInvitation);
  router.post('/api/admin/invitations/:invitation_id/resend', resendInvitation);
  router.post('/api/admin/invitations/:invitation_id/revoke', revokeInvitation);
  return router;
}

async function listInvitations(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'member.read');
  const sql = state.sql;
  if (!sql) return c.json([]);

  const rows = await sql`
    SELECT inv.id, inv.tenant_id, inv.email, inv.name, inv.roles, inv.kb_grants,
           CASE
             WHEN inv.status = 'pending' AND inv.expires_at < NOW() THEN 'expired'
             ELSE inv.status
           END AS status,
           inv.invited_by,
           COALESCE(NULLIF(u.name, ''), u.email) AS invited_by_label,
           inv.accepted_by, inv.expires_at, inv.accepted_at, inv.revoked_at, inv.created_at
    FROM tenant_invitation inv
    LEFT JOIN app_user u ON u.id = inv.invited_by
    WHERE inv.tenant_id = ${actor.tenant_id}
    ORDER BY inv.created_at DESC
    LIMIT 100
  `;
  return c.json(rows.map(invitationFromRow));
}

async function createInvitation(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'member.write');
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '邀请功能需要数据库');
  const req = await c.req.json() as InvitationCreateRequest;

  const email = normalizeEmail(req.email);
  const existing = await sql`
    SELECT EXISTS(
      SELECT 1
      FROM app_user u
      JOIN tenant_member tm ON tm.user_id = u.id
      WHERE tm.tenant_id = ${actor.tenant_id}
        AND lower(u.email) = lower(${email})
        AND NOT (
          tm.roles <@ ARRAY['super_admin']::text[]
          AND cardinality(tm.roles) > 0
          AND EXISTS (
            SELECT 1 FROM platform_admin pa
            WHERE pa.user_id = u.id AND pa.status = 'active'
          )
        )
    ) AS exists
  `;
  if (existing[0]?.exists) {
    throw AppError.conflictWith(
      'TENANT_MEMBER_EXISTS', '该账号已经是当前租户成员，请直接修改成员状态或角色');
  }

  const roles = normalizeInvitationRoles(req.roles ?? []);
  const grants = await normalizeInvitationGrants(
    sql, actor.tenant_id, req.kb_grants ?? []);
  const expiresAt = new Date(Date.now() + clampDays(req.expires_in_days ?? 7) * 86_400_000);
  const token = newInvitationToken();
  const tokenHash = invitationTokenHash(token);
  const name = (req.name ?? '').trim().length > 0 ? req.name!.trim() : null;

  const inserted = await sql`
    INSERT INTO tenant_invitation
      (tenant_id, email, name, roles, kb_grants, token_hash, status, invited_by, expires_at)
    VALUES (${actor.tenant_id}, ${email}, ${name}, ${roles}, ${sql.json(grants as unknown as JSONValue)}, ${tokenHash}, 'pending', ${actor.user_id}, ${expiresAt})
    ON CONFLICT DO NOTHING
    RETURNING id, tenant_id, email, name, roles, kb_grants, status, invited_by,
              NULL::text AS invited_by_label, accepted_by, expires_at, accepted_at,
              revoked_at, created_at
  `;
  const row = inserted[0];
  if (!row) {
    throw AppError.conflictWith('INVITATION_EXISTS', '该邮箱已有待接受邀请');
  }
  const invitation = invitationFromRow(row);
  invitation.invite_url = inviteUrl(token);
  await recordAuditEvent(sql, actor, 'tenant_invitation.create', 'tenant_invitation', invitation.id, {
    email: invitation.email,
    roles: invitation.roles,
    kb_grants: invitation.kb_grants,
    expires_at: invitation.expires_at,
  });
  return c.json(invitation);
}

async function resendInvitation(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'member.write');
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '邀请功能需要数据库');
  const invitationId = c.req.param('invitation_id')!;

  const token = newInvitationToken();
  const tokenHash = invitationTokenHash(token);
  const expiresAt = new Date(Date.now() + 7 * 86_400_000);
  const updated = await sql`
    UPDATE tenant_invitation
    SET token_hash = ${tokenHash}, expires_at = ${expiresAt}, status = 'pending',
        revoked_at = NULL, updated_at = NOW()
    WHERE tenant_id = ${actor.tenant_id}
      AND id = ${invitationId}
      AND status IN ('pending', 'expired', 'revoked')
      AND accepted_at IS NULL
    RETURNING id, tenant_id, email, name, roles, kb_grants, status, invited_by,
              NULL::text AS invited_by_label, accepted_by, expires_at, accepted_at,
              revoked_at, created_at
  `;
  const row = updated[0];
  if (!row) throw invitationNotFound();
  const invitation = invitationFromRow(row);
  invitation.invite_url = inviteUrl(token);
  await recordAuditEvent(sql, actor, 'tenant_invitation.resend', 'tenant_invitation', invitation.id, {
    email: invitation.email, expires_at: invitation.expires_at,
  });
  return c.json(invitation);
}

async function revokeInvitation(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'member.write');
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '邀请功能需要数据库');
  const invitationId = c.req.param('invitation_id')!;

  const updated = await sql`
    UPDATE tenant_invitation
    SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
    WHERE tenant_id = ${actor.tenant_id}
      AND id = ${invitationId}
      AND status = 'pending'
      AND accepted_at IS NULL
    RETURNING id, tenant_id, email, name, roles, kb_grants, status, invited_by,
              NULL::text AS invited_by_label, accepted_by, expires_at, accepted_at,
              revoked_at, created_at
  `;
  const row = updated[0];
  if (!row) throw invitationNotFound();
  const invitation = invitationFromRow(row);
  await recordAuditEvent(sql, actor, 'tenant_invitation.revoke', 'tenant_invitation', invitation.id, {
    email: invitation.email,
  });
  return c.json(invitation);
}

function normalizeEmail(value: string): string {
  const email = (value ?? '').trim().toLowerCase();
  if (email.length === 0 || !email.includes('@')) {
    throw AppError.badRequest('EMAIL_INVALID', '请输入有效邮箱');
  }
  return email;
}

function normalizeInvitationRoles(values: string[]): string[] {
  if (values.length === 0) {
    throw AppError.badRequest('INVITATION_ROLE_REQUIRED', '邀请至少需要一个角色');
  }
  const roles: string[] = [];
  for (const value of values) {
    let role: string;
    switch ((value ?? '').trim()) {
      case 'tenant_admin': role = 'tenant_admin'; break;
      case 'end_user': case 'user': case 'analyst': case 'viewer': role = 'end_user'; break;
      case 'super_admin': throw AppError.forbidden();
      default:
        throw AppError.badRequest(
          'INVITATION_ROLE_INVALID', '可邀请角色只能是 tenant_admin / end_user');
    }
    if (!roles.includes(role)) roles.push(role);
  }
  return roles;
}

async function normalizeInvitationGrants(
  sql: Sql, tenantId: string, grants: InvitationGrantRequest[],
): Promise<InvitationGrant[]> {
  const out: InvitationGrant[] = [];
  for (const grant of grants) {
    await ensureKbExists(sql, tenantId, grant.kb_id);
    const permission = normalizeAclPermission(grant.permission);
    if (!out.some((item) => item.kb_id === grant.kb_id && item.permission === permission)) {
      out.push({ kb_id: grant.kb_id, permission });
    }
  }
  return out;
}

function invitationFromRow(row: Record<string, unknown>): TenantInvitationSummary {
  const grants = row.kb_grants;
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    email: (row.email as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    roles: (row.roles as string[]) ?? [],
    kb_grants: Array.isArray(grants) ? grants : [],
    status: String(row.status),
    invited_by: String(row.invited_by),
    invited_by_label: (row.invited_by_label as string | null) ?? null,
    accepted_by: (row.accepted_by as string | null) ?? null,
    expires_at: toRfc3339(new Date(row.expires_at as Date | string)),
    accepted_at: optionalRfc3339(row.accepted_at),
    revoked_at: optionalRfc3339(row.revoked_at),
    created_at: toRfc3339(new Date(row.created_at as Date | string)),
    invite_url: null,
  };
}

function optionalRfc3339(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toRfc3339(new Date(value as Date | string));
}

function inviteUrl(token: string): string {
  return `/invite?token=${token}`;
}

function invitationNotFound(): AppError {
  return AppError.notFound('INVITATION_NOT_FOUND', '邀请不存在、已接受或已撤销');
}
