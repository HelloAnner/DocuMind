// 移植自 apps/api-rs/src/api/system_tenant_invitations.rs
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { JSONValue, Sql } from 'postgres';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import type { AppState } from '../state.ts';
import { requireSuperAdmin } from '../auth/permissions.ts';
import { toRfc3339 } from '../infra/time.ts';
import { clampDays, invitationTokenHash, newInvitationToken } from './system_tenants.ts';

export interface GenerateAdminInvitationRequest {
  expires_in_days?: number | null;
}

export function systemTenantInvitationsRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.post('/api/system/tenants/:id/invitations/resend', generateAdminInvitation);
  return router;
}

export async function generateAdminInvitation(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireSuperAdmin(actor);
  const sql = requiredSql(state);
  const tenantId = c.req.param('id')!;
  const req = await c.req.json() as GenerateAdminInvitationRequest;

  const tenants = await sql`
    SELECT status FROM tenant WHERE id = ${tenantId}
  `;
  const tenant = tenants[0];
  if (!tenant) {
    throw AppError.notFound('TENANT_NOT_FOUND', '租户不存在');
  }
  const tenantStatus = String(tenant.status);
  if (tenantStatus !== 'pending' && tenantStatus !== 'active') {
    throw AppError.conflictWith('TENANT_NOT_INVITABLE', '只有待加入或运行中的租户可以邀请管理员');
  }

  const token = newInvitationToken();
  const tokenHash = invitationTokenHash(token);
  const expiresAt = new Date(Date.now() + clampDays(req.expires_in_days ?? 7) * 86_400_000);

  const row = await sql.begin(async (tx) => {
    const invitations = await tx`
      INSERT INTO tenant_invitation
        (tenant_id, email, name, roles, kb_grants, token_hash, status, invited_by, expires_at)
      VALUES (${tenantId}, NULL, NULL, ARRAY['tenant_admin'], '[]'::jsonb, ${tokenHash}, 'pending', ${actor.user_id}, ${expiresAt})
      ON CONFLICT (tenant_id) WHERE status = 'pending' AND email IS NULL
      DO UPDATE SET token_hash = EXCLUDED.token_hash,
                    expires_at = EXCLUDED.expires_at,
                    revoked_at = NULL,
                    updated_at = NOW()
      RETURNING id, expires_at
    `;
    const invitation = invitations[0];
    if (!invitation) {
      throw AppError.internal('tenant invitation upsert returned no row');
    }
    const detail: JSONValue = { expires_at: toRfc3339(new Date(invitation.expires_at as Date | string)) };
    await tx`
      INSERT INTO audit_log
        (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
      VALUES (${tenantId}, ${actor.user_id}, 'super_admin', 'tenant.admin_invitation.generate',
              'tenant_invitation', ${String(invitation.id)}, ${tx.json(detail)})
    `;
    return invitation;
  });

  const expiresAtValue = new Date(row.expires_at as Date | string);
  return c.json({
    id: String(row.id),
    expires_at: toRfc3339(expiresAtValue),
    invite_url: `/invite?token=${token}`,
  });
}

function requiredSql(state: AppState): Sql {
  if (!state.sql) throw AppError.badRequest('DB_REQUIRED', '租户管理功能需要数据库');
  return state.sql;
}
