import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv } from '../http/types.ts';
import { AppError } from '../errors.ts';
import { requirePermission } from '../auth/permissions.ts';
import {
  clampDays,
  invitationTokenHash,
  newInvitationToken,
  normalizeInvitationAccount,
} from './system_tenants.ts';

const INVITATION_ROLES: Record<string, true> = { tenant_admin: true, end_user: true };
const INVITATION_SELECT = `
  SELECT ti.id, ti.tenant_id, ti.kind, ti.invitee_username_normalized, ti.roles,
         ti.kb_grants, ti.status, ti.invited_by, ti.accepted_by, ti.expires_at,
         ti.accepted_at, ti.revoked_at, ti.created_at,
         COALESCE(NULLIF(au.name, ''), au.login_id) AS invited_by_label
  FROM tenant_invitation ti
  LEFT JOIN app_user au ON au.id = ti.invited_by
`;

interface InvitationGrant {
  kb_id: string;
  permission: 'query' | 'edit' | 'manage';
}

interface CreateInvitationRequest {
  invitee_username?: string;
  roles?: string[];
  kb_grants?: Array<{ kb_id?: string; permission?: string }>;
  expires_in_days?: number;
}

export function adminInvitationsRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/v1/tenant/invitations', listInvitations);
  router.post('/api/v1/tenant/invitations', createInvitation);
  router.post('/api/v1/tenant/invitations/:id/resend', resendInvitation);
  router.post('/api/v1/tenant/invitations/:id/revoke', revokeInvitation);
  return router;
}

async function listInvitations(c: Context<AppEnv>) {
  const { sql, actor } = invitationContext(c);
  const rows = await sql.unsafe(
    `${INVITATION_SELECT}
     WHERE ti.tenant_id = $1
     ORDER BY ti.created_at DESC
     LIMIT 200`,
    [actor.tenant_id],
  );
  return c.json({ items: rows.map(invitationFromRow) });
}

async function createInvitation(c: Context<AppEnv>) {
  const { sql, actor } = invitationContext(c);
  const req = await c.req.json<CreateInvitationRequest>();
  const invitee = normalizeInvitationAccount(req.invitee_username ?? '');
  const roles = normalizeRoles(req.roles);
  const grants = await normalizeInvitationGrants(sql, actor.tenant_id, req.kb_grants ?? []);
  const expiresInDays = clampDays(req.expires_in_days ?? 7);
  const token = newInvitationToken();
  const hash = invitationTokenHash(token);
  const rows = await sql.begin(async (tx) => {
    const accounts = await tx`
      SELECT au.id, tm.status
      FROM app_user au
      LEFT JOIN tenant_member tm
        ON tm.user_id = au.id AND tm.tenant_id = ${actor.tenant_id}
      WHERE lower(au.login_id) = ${invitee}
      LIMIT 1
    `;
    const account = accounts[0];
    if (!account) {
      throw AppError.notFound('INVITEE_ACCOUNT_NOT_FOUND', '受邀账号尚未注册');
    }
    if (account.status) {
      throw AppError.conflictWith(
        'INVITEE_ALREADY_MEMBER',
        account.status === 'active' ? '该账号已是租户成员' : '该账号成员状态不可通过邀请恢复',
      );
    }
    const existing = await tx`
      SELECT id FROM tenant_invitation
      WHERE tenant_id = ${actor.tenant_id}
        AND kind = 'targeted'
        AND invitee_username_normalized = ${invitee}
        AND status = 'pending'
      LIMIT 1
    `;
    if (existing[0]) {
      throw AppError.conflictWith('INVITATION_ALREADY_PENDING', '该账号已有待接受邀请');
    }
    const created = await tx`
      INSERT INTO tenant_invitation (
        tenant_id, token_hash, kind, invitee_username_normalized, roles,
        kb_grants, status, invited_by, expires_at
      )
      VALUES (
        ${actor.tenant_id}, ${hash}, 'targeted', ${invitee}, ${roles},
        ${tx.json(grants.map(({ kb_id, permission }) => ({ kb_id, permission })))}, 'pending', ${actor.user_id},
        NOW() + (${expiresInDays} * INTERVAL '1 day')
      )
      RETURNING id
    `;
    await tx`
      INSERT INTO audit_log (
        tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, detail
      )
      VALUES (
        ${actor.tenant_id}, ${actor.user_id}, ${actor.roles[0] ?? 'tenant_admin'},
        'invitation.create', 'tenant_invitation', ${created[0]!.id},
        ${tx.json({ invitee_username: invitee, roles, kb_grants: grants.map(({ kb_id, permission }) => ({ kb_id, permission })) })}
      )
    `;
    return created;
  });
  const invitation = await invitationById(sql, actor.tenant_id, String(rows[0]!.id));
  return c.json({ invitation, invite_url: inviteUrl(token) }, 201);
}

async function resendInvitation(c: Context<AppEnv>) {
  const { sql, actor } = invitationContext(c);
  const id = c.req.param('id')!;
  const req = await optionalJson<{ expires_in_days?: number }>(c);
  const token = newInvitationToken();
  const hash = invitationTokenHash(token);
  const expiresInDays = clampDays(req.expires_in_days ?? 7);
  const rows = await sql`
    UPDATE tenant_invitation
    SET token_hash = ${hash}, status = 'pending',
        expires_at = NOW() + (${expiresInDays} * INTERVAL '1 day'),
        accepted_by = NULL, accepted_at = NULL, revoked_at = NULL, updated_at = NOW()
    WHERE id = ${id} AND tenant_id = ${actor.tenant_id}
      AND kind = 'targeted' AND status <> 'accepted'
    RETURNING id
  `;
  if (!rows[0]) throw invitationNotFound();
  const invitation = await invitationById(sql, actor.tenant_id, id);
  return c.json({ invitation, invite_url: inviteUrl(token) });
}

async function revokeInvitation(c: Context<AppEnv>) {
  const { sql, actor } = invitationContext(c);
  const id = c.req.param('id')!;
  const rows = await sql`
    UPDATE tenant_invitation
    SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
    WHERE id = ${id} AND tenant_id = ${actor.tenant_id}
      AND kind = 'targeted' AND status = 'pending'
    RETURNING id
  `;
  if (!rows[0]) throw invitationNotFound();
  return c.json({ ok: true });
}

function invitationContext(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'member.write');
  if (!state.sql) throw AppError.badRequest('DB_REQUIRED', '邀请功能需要数据库');
  if (!actor.tenant_id) throw AppError.badRequest('TENANT_CONTEXT_REQUIRED', '缺少租户上下文');
  return { sql: state.sql, actor };
}

async function invitationById(sql: Sql, tenantId: string, id: string) {
  const rows = await sql.unsafe(
    `${INVITATION_SELECT} WHERE ti.tenant_id = $1 AND ti.id = $2 LIMIT 1`,
    [tenantId, id],
  );
  if (!rows[0]) throw invitationNotFound();
  return invitationFromRow(rows[0]);
}

function invitationFromRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    kind: String(row.kind),
    invitee_username: row.invitee_username_normalized === null
      ? null
      : String(row.invitee_username_normalized),
    roles: Array.isArray(row.roles) ? row.roles : [],
    kb_grants: Array.isArray(row.kb_grants) ? row.kb_grants : [],
    status: effectiveStatus(row),
    invited_by: String(row.invited_by),
    invited_by_label: row.invited_by_label === null ? null : String(row.invited_by_label),
    accepted_by: row.accepted_by === null ? null : String(row.accepted_by),
    expires_at: new Date(row.expires_at as Date | string).toISOString(),
    accepted_at: optionalTime(row.accepted_at),
    revoked_at: optionalTime(row.revoked_at),
    created_at: new Date(row.created_at as Date | string).toISOString(),
  };
}

function effectiveStatus(row: Record<string, unknown>): string {
  if (row.status === 'pending' && new Date(row.expires_at as Date | string) <= new Date()) {
    return 'expired';
  }
  return String(row.status);
}

function optionalTime(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as Date | string).toISOString();
}

function normalizeRoles(value: string[] | undefined): string[] {
  const roles = [...new Set(value?.length ? value : ['end_user'])];
  if (roles.some((role) => !INVITATION_ROLES[role])) {
    throw AppError.badRequest('INVITATION_ROLE_INVALID', '邀请角色仅支持 tenant_admin 或 end_user');
  }
  return roles;
}

async function normalizeInvitationGrants(
  sql: Sql,
  tenantId: string,
  value: Array<{ kb_id?: string; permission?: string }>,
): Promise<InvitationGrant[]> {
  const grants = value.map((grant) => ({
    kb_id: (grant.kb_id ?? '').trim(),
    permission: grant.permission ?? 'query',
  }));
  if (grants.some((grant) => !grant.kb_id || !['query', 'edit', 'manage'].includes(grant.permission))) {
    throw AppError.badRequest('INVITATION_KB_GRANT_INVALID', '知识库授权无效');
  }
  const ids = [...new Set(grants.map((grant) => grant.kb_id))];
  if (ids.length) {
    const rows = await sql`
      SELECT id FROM knowledge_base
      WHERE tenant_id = ${tenantId} AND id = ANY(${ids})
    `;
    if (rows.length !== ids.length) {
      throw AppError.badRequest('INVITATION_KB_NOT_FOUND', '存在不属于当前租户的知识库');
    }
  }
  return grants.map((grant) => ({
    kb_id: grant.kb_id,
    permission: grant.permission as InvitationGrant['permission'],
  }));
}

async function optionalJson<T>(c: Context<AppEnv>): Promise<Partial<T>> {
  const text = await c.req.text();
  return text ? JSON.parse(text) as Partial<T> : {};
}

function inviteUrl(token: string): string {
  return `/invite#token=${encodeURIComponent(token)}`;
}

function invitationNotFound(): AppError {
  return AppError.notFound('INVITATION_NOT_FOUND', '邀请不存在或当前状态不可操作');
}
