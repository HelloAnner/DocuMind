// 移植自 apps/api-rs/src/api/system_tenants.rs
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { JSONValue, Sql, TransactionSql } from 'postgres';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import type { AppState } from '../state.ts';
import type { CurrentActor } from '../models/identity.ts';
import { requireSuperAdmin } from '../auth/permissions.ts';
import { newUuid } from '../infra/uuid.ts';
import { toRfc3339 } from '../infra/time.ts';

interface CreateTenantRequest {
  name: string; slug?: string | null; plan?: string | null; expires_in_days?: number | null;
}
interface UpdateTenantRequest { name?: string | null; plan?: string | null; status?: string | null; }

export interface CreatedTenant { id: string; name: string; slug: string; plan: string; status: string; }
export interface CreatedInvitation {
  id: string; email: string | null; roles: string[]; status: string;
  expires_at: string; invite_url: string;
}
export interface CreateTenantResponse { tenant: CreatedTenant; invitation: CreatedInvitation; }

/**
 * system_tenants.rs 在 Rust 里由 system.rs 的 router() 挂载 /api/system/tenants。
 * TS 侧按文件拆分：本 router 只注册租户写操作，读操作（GET list/detail）留在 system.ts，
 * 避免两个 router 注册同一路径。
 */
export function systemTenantsRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.post('/api/system/tenants', createTenant);
  router.patch('/api/system/tenants/:id', updateTenant);
  router.delete('/api/system/tenants/:id', requestTenantDeletion);
  return router;
}

export async function createTenant(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireSuperAdmin(actor);
  const sql = requiredSql(state);
  const req = await c.req.json() as CreateTenantRequest;
  const name = normalizeName(req.name);
  const slug = normalizeSlug(req.slug ?? req.name);
  const plan = normalizePlan(req.plan);
  const expiresInDays = clampDays(req.expires_in_days ?? 7);
  const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);

  const slugRows = await sql`
    SELECT EXISTS(SELECT 1 FROM tenant WHERE lower(slug) = lower(${slug})) AS exists
  `;
  if (slugRows[0]?.exists) {
    throw AppError.conflictWith('TENANT_SLUG_EXISTS', '租户标识已存在');
  }

  const tenantId = newUuid();
  const invitationId = newUuid();
  const token = newInvitationToken();
  const tokenHash = invitationTokenHash(token);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO tenant (id, name, slug, plan, status)
      VALUES (${tenantId}, ${name}, ${slug}, ${plan}, 'pending')
    `;
    await tx`
      INSERT INTO tenant_invitation
        (id, tenant_id, email, name, roles, kb_grants, token_hash, status, invited_by, expires_at)
      VALUES (${invitationId}, ${tenantId}, NULL, NULL, ARRAY['tenant_admin'], '[]'::jsonb, ${tokenHash}, 'pending', ${actor.user_id}, ${expiresAt})
    `;
    await insertSystemAudit(tx, tenantId, actor.user_id, 'tenant.create', 'tenant', tenantId, {
      name, slug, plan, invitation_id: invitationId, expires_at: toRfc3339(expiresAt),
    });
  });

  const response: CreateTenantResponse = {
    tenant: { id: tenantId, name, slug, plan, status: 'pending' },
    invitation: {
      id: invitationId, email: null, roles: ['tenant_admin'], status: 'pending',
      expires_at: toRfc3339(expiresAt), invite_url: `/invite?token=${token}`,
    },
  };
  return c.json(response);
}

export async function updateTenant(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireSuperAdmin(actor);
  const req = await c.req.json() as UpdateTenantRequest;
  if (req.name == null && req.plan == null && req.status == null) {
    throw AppError.badRequest('TENANT_UPDATE_EMPTY', '请至少修改一个租户字段');
  }
  const sql = requiredSql(state);
  const tenantId = c.req.param('id')!;
  const currents = await sql`
    SELECT name, slug, plan, status FROM tenant WHERE id = ${tenantId}
  `;
  const current = currents[0];
  if (!current) throw tenantNotFound();
  const currentStatus = String(current.status);
  const name = req.name != null ? normalizeName(req.name) : null;
  const plan = req.plan != null ? normalizePlan(req.plan) : null;
  const status = req.status != null ? normalizeStatus(req.status) : null;
  if (status !== null) ensureStatusTransition(currentStatus, status);

  const rows = await sql`
    UPDATE tenant
    SET name = COALESCE(${name}, name),
        plan = COALESCE(${plan}, plan),
        status = COALESCE(${status}, status),
        suspended_at = CASE WHEN ${status} = 'suspended' THEN NOW() WHEN ${status} = 'active' THEN NULL ELSE suspended_at END,
        archived_at = CASE WHEN ${status} = 'archived' THEN NOW() WHEN ${status} = 'active' THEN NULL ELSE archived_at END,
        updated_at = NOW()
    WHERE id = ${tenantId}
    RETURNING id, name, slug, plan, status, updated_at
  `;
  const updated = rows[0]!;
  await insertSystemAuditDirect(sql, tenantId, actor.user_id, 'tenant.update', {
    previous_status: currentStatus,
    name: String(updated.name), plan: String(updated.plan), status: String(updated.status),
  });
  return c.json({
    id: String(updated.id), name: String(updated.name), slug: String(updated.slug),
    plan: String(updated.plan), status: String(updated.status),
    updated_at: toRfc3339(new Date(updated.updated_at as Date | string)),
  });
}

export async function requestTenantDeletion(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireSuperAdmin(actor);
  const tenantId = c.req.param('id')!;
  if (tenantId === actor.tenant_id) {
    throw AppError.conflictWith(
      'CURRENT_TENANT_DELETE_FORBIDDEN', '不能删除当前平台管理员的兼容登录租户');
  }
  const sql = requiredSql(state);
  const rows = await sql`SELECT slug, status FROM tenant WHERE id = ${tenantId}`;
  const row = rows[0];
  if (!row) throw tenantNotFound();
  const slug = String(row.slug);
  if (c.req.query('confirm_slug') !== slug) {
    throw AppError.badRequest('TENANT_DELETE_CONFIRMATION_MISMATCH', '请输入正确的租户 slug 以确认删除');
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE tenant
      SET status = 'deletion_pending',
          deletion_requested_at = NOW(),
          deletion_requested_by = ${actor.user_id},
          updated_at = NOW()
      WHERE id = ${tenantId}
    `;
    await tx`
      UPDATE tenant_invitation
      SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
      WHERE tenant_id = ${tenantId} AND status = 'pending'
    `;
    await insertSystemAudit(tx, tenantId, actor.user_id, 'tenant.deletion_requested', 'tenant', tenantId, {
      slug, previous_status: String(row.status),
    });
  });
  return c.json({ id: tenantId, slug, status: 'deletion_pending', recoverable: true });
}

function requiredSql(state: AppState): Sql {
  if (!state.sql) throw AppError.badRequest('DB_REQUIRED', '租户管理功能需要数据库');
  return state.sql;
}

export function normalizeName(value: string): string {
  const name = (value ?? '').trim();
  if (name.length === 0 || [...name].length > 128) {
    throw AppError.badRequest('TENANT_NAME_INVALID', '租户名称不能为空且不能超过 128 个字符');
  }
  return name;
}

export function normalizeSlug(value: string): string {
  let slug = '';
  for (const ch of (value ?? '').trim()) {
    if (/[a-z0-9]/i.test(ch)) slug += ch.toLowerCase();
    else if ((ch === '-' || ch === '_' || /\s/.test(ch)) && !slug.endsWith('-')) slug += '-';
  }
  slug = slug.replace(/^-+|-+$/g, '').slice(0, 63);
  if (slug.length < 2) {
    throw AppError.badRequest('TENANT_SLUG_INVALID', '租户标识至少需要 2 个字母、数字或连字符');
  }
  return slug;
}

export function normalizePlan(value?: string | null): string {
  switch ((value ?? 'enterprise').trim()) {
    case 'trial': return 'trial';
    case 'team': return 'team';
    case 'enterprise': return 'enterprise';
    default:
      throw AppError.badRequest('TENANT_PLAN_INVALID', '租户套餐只能是 trial、team 或 enterprise');
  }
}

export function normalizeStatus(value: string): string {
  switch (value.trim()) {
    case 'pending': case 'active': case 'suspended': case 'archived': case 'deletion_pending':
      return value.trim();
    default:
      throw AppError.badRequest('TENANT_STATUS_INVALID', '租户状态无效');
  }
}

export function ensureStatusTransition(current: string, next: string): void {
  const allowed = current === next
    || (current === 'pending' && ['active', 'suspended', 'archived'].includes(next))
    || (current === 'active' && ['suspended', 'archived'].includes(next))
    || (current === 'suspended' && ['active', 'archived'].includes(next))
    || (current === 'archived' && next === 'active');
  if (!allowed) {
    throw AppError.conflictWith(
      'TENANT_STATUS_TRANSITION_INVALID', `租户状态不能从 ${current} 变更为 ${next}`);
  }
}

export function newInvitationToken(): string {
  return `inv_${newUuid().replace(/-/g, '')}${newUuid().replace(/-/g, '')}`;
}

export function invitationTokenHash(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex');
}

export function clampDays(days: number): number {
  return Math.min(30, Math.max(1, Math.trunc(days)));
}

export async function insertSystemAudit(
  tx: TransactionSql, tenantId: string, actorUserId: string, action: string,
  resourceType: string, resourceId: string, detail: JSONValue,
): Promise<void> {
  await tx`
    INSERT INTO audit_log
      (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
    VALUES (${tenantId}, ${actorUserId}, 'super_admin', ${action}, ${resourceType}, ${resourceId}, ${tx.json(detail)})
  `;
}

export async function insertSystemAuditDirect(
  sql: Sql, tenantId: string, actorUserId: string, action: string, detail: JSONValue,
): Promise<void> {
  await sql`
    INSERT INTO audit_log
      (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
    VALUES (${tenantId}, ${actorUserId}, 'super_admin', ${action}, 'tenant', ${tenantId}, ${sql.json(detail)})
  `;
}

export function tenantNotFound(): AppError {
  return AppError.notFound('TENANT_NOT_FOUND', '租户不存在');
}
