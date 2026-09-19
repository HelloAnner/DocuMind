import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Sql } from 'postgres';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import type { AppState } from '../state.ts';
import { requireSuperAdmin } from '../auth/permissions.ts';
import { toRfc3339 } from '../infra/time.ts';
import { clampDays, invitationTokenHash, newInvitationToken } from './system_tenants.ts';

interface OwnerInvitationRequest { expires_in_days?: number | null; }

export function systemTenantInvitationsRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.post('/api/v1/system/tenants/:id/owner-invitation', createOwnerInvitation);
  router.post('/api/v1/system/tenants/:id/owner-invitation/resend', resendOwnerInvitation);
  router.post('/api/v1/system/tenants/:id/owner-invitation/revoke', revokeOwnerInvitation);
  return router;
}

async function createOwnerInvitation(c: Context<AppEnv>) {
  const { sql, actor, tenantId } = invitationContext(c);
  await ensureTenantCanReceiveOwner(sql, tenantId);
  const pending = await sql`
    SELECT 1 FROM tenant_invitation
    WHERE tenant_id = ${tenantId} AND kind = 'bootstrap_owner' AND status = 'pending'
    LIMIT 1
  `;
  if (pending[0]) {
    throw AppError.conflictWith('OWNER_INVITATION_ALREADY_PENDING', '租户已有待接受的所有者邀请');
  }
  const req = await optionalJson<OwnerInvitationRequest>(c);
  const { token, hash, expiresAt } = newToken(req.expires_in_days);
  const rows = await sql`
    INSERT INTO tenant_invitation (
      tenant_id, token_hash, kind, invitee_username_normalized, roles,
      kb_grants, status, invited_by, expires_at
    )
    VALUES (
      ${tenantId}, ${hash}, 'bootstrap_owner', NULL, ARRAY['tenant_owner'],
      '[]'::jsonb, 'pending', ${actor.user_id}, ${expiresAt}
    )
    RETURNING id, expires_at
  `;
  await sql`
    INSERT INTO audit_log
      (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
    VALUES (
      ${tenantId}, ${actor.user_id}, 'super_admin', 'tenant.owner_invitation.create',
      'tenant_invitation', ${String(rows[0]!.id)}, '{}'::jsonb
    )
  `;
  return c.json(ownerInvitation(rows[0]!, token), 201);
}

async function resendOwnerInvitation(c: Context<AppEnv>) {
  const { sql, actor, tenantId } = invitationContext(c);
  await ensureTenantCanReceiveOwner(sql, tenantId);
  const req = await optionalJson<OwnerInvitationRequest>(c);
  const { token, hash, expiresAt } = newToken(req.expires_in_days);
  const rows = await sql`
    UPDATE tenant_invitation
    SET token_hash = ${hash}, expires_at = ${expiresAt},
        revoked_at = NULL, updated_at = NOW()
    WHERE tenant_id = ${tenantId} AND kind = 'bootstrap_owner' AND status = 'pending'
    RETURNING id, expires_at
  `;
  if (!rows[0]) {
    throw AppError.notFound('OWNER_INVITATION_NOT_FOUND', '待接受的租户所有者邀请不存在');
  }
  await sql`
    INSERT INTO audit_log
      (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
    VALUES (
      ${tenantId}, ${actor.user_id}, 'super_admin', 'tenant.owner_invitation.resend',
      'tenant_invitation', ${String(rows[0].id)}, '{}'::jsonb
    )
  `;
  return c.json(ownerInvitation(rows[0], token));
}

async function revokeOwnerInvitation(c: Context<AppEnv>) {
  const { sql, actor, tenantId } = invitationContext(c);
  const rows = await sql`
    UPDATE tenant_invitation
    SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
    WHERE tenant_id = ${tenantId} AND kind = 'bootstrap_owner' AND status = 'pending'
    RETURNING id
  `;
  if (!rows[0]) {
    throw AppError.notFound('OWNER_INVITATION_NOT_FOUND', '待接受的租户所有者邀请不存在');
  }
  await sql`
    INSERT INTO audit_log
      (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
    VALUES (
      ${tenantId}, ${actor.user_id}, 'super_admin', 'tenant.owner_invitation.revoke',
      'tenant_invitation', ${String(rows[0].id)}, '{}'::jsonb
    )
  `;
  return c.json({ invitation: { id: String(rows[0].id), status: 'revoked' } });
}

function invitationContext(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireSuperAdmin(actor);
  return { sql: requiredSql(state), actor, tenantId: c.req.param('id')! };
}

async function ensureTenantCanReceiveOwner(sql: Sql, tenantId: string): Promise<void> {
  const tenants = await sql`
    SELECT status FROM tenant WHERE id = ${tenantId}
  `;
  if (!tenants[0]) throw AppError.notFound('TENANT_NOT_FOUND', '租户不存在');
  if (!['pending', 'active'].includes(String(tenants[0].status))) {
    throw AppError.conflictWith('TENANT_NOT_INVITABLE', '租户当前不可邀请所有者');
  }
  const owners = await sql`
    SELECT 1 FROM tenant_member
    WHERE tenant_id = ${tenantId} AND status = 'active'
      AND 'tenant_owner' = ANY(roles)
    LIMIT 1
  `;
  if (owners[0]) throw AppError.conflictWith('TENANT_OWNER_EXISTS', '租户已有所有者');
}

function newToken(expiresInDays: number | null | undefined) {
  const token = newInvitationToken();
  return {
    token,
    hash: invitationTokenHash(token),
    expiresAt: new Date(Date.now() + clampDays(expiresInDays ?? 7) * 86_400_000),
  };
}

function ownerInvitation(row: Record<string, unknown>, token: string) {
  return {
    invitation: {
      id: String(row.id),
      kind: 'bootstrap_owner',
      invitee_username: null,
      roles: ['tenant_owner'],
      status: 'pending',
      expires_at: toRfc3339(new Date(row.expires_at as Date | string)),
    },
    invite_url: `/invite#token=${encodeURIComponent(token)}`,
  };
}

async function optionalJson<T>(c: Context<AppEnv>): Promise<Partial<T>> {
  const text = await c.req.text();
  return text ? JSON.parse(text) as Partial<T> : {};
}

function requiredSql(state: AppState): Sql {
  if (!state.sql) throw AppError.badRequest('DB_REQUIRED', '租户管理功能需要数据库');
  return state.sql;
}
