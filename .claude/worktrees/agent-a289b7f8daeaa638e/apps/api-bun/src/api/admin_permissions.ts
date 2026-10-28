// 移植自 apps/api-rs/src/api/admin.rs 的 permissions 部分
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Sql } from 'postgres';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import { recordAuditEvent } from '../auth/audit.ts';
import { requirePermission, requireTenantAdmin } from '../auth/permissions.ts';
import { isUuid } from '../infra/uuid.ts';
import { toRfc3339 } from '../infra/time.ts';
import { ensureKbExists, normalizeAclPermission } from './admin_support.ts';

interface PermissionGrantRequest {
  kb_id: string;
  subject_type: string;
  subject_id: string;
  permission: string;
}

export interface KnowledgeBaseAuthorization {
  id: string;
  tenant_id: string;
  kb_id: string;
  kb_name: string;
  subject_type: string;
  subject_id: string;
  subject_label: string;
  permission: string;
  created_by: string | null;
  created_by_label: string | null;
  created_at: string;
}

export function adminPermissionsRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/admin/permissions', listPermissions);
  router.post('/api/admin/permissions', grantPermission);
  router.delete('/api/admin/permissions/:acl_id', revokePermission);
  return router;
}

async function listPermissions(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'kb.manage');
  const sql = state.sql;
  if (!sql) return c.json([]);

  const rows = await sql`
    SELECT acl.id, acl.tenant_id, acl.kb_id, kb.name AS kb_name,
           acl.subject_type, acl.subject_id, acl.permission, acl.created_by,
           COALESCE(NULLIF(u.name, ''), u.email) AS user_label,
           COALESCE(NULLIF(c.name, ''), c.email) AS created_by_label,
           acl.created_at
    FROM knowledge_base_acl acl
    JOIN knowledge_base kb
      ON kb.tenant_id = acl.tenant_id
     AND kb.id = acl.kb_id
    LEFT JOIN app_user u
      ON acl.subject_type = 'user'
     AND u.id::text = acl.subject_id
    LEFT JOIN app_user c
      ON c.id = acl.created_by
    WHERE acl.tenant_id = ${actor.tenant_id}
    ORDER BY kb.name ASC,
             acl.subject_type ASC,
             acl.subject_id ASC,
             CASE acl.permission
               WHEN 'manage' THEN 0
               WHEN 'write' THEN 1
               ELSE 2
             END
  `;
  return c.json(rows.map(permissionFromRow));
}

async function grantPermission(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'kb.manage');
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('ACL_REQUIRES_POSTGRES', '知识库授权需要启用 PostgreSQL');
  const req = await c.req.json() as PermissionGrantRequest;

  const subjectType = normalizeAclSubjectType(req.subject_type);
  const permission = normalizeAclPermission(req.permission);
  await ensureKbExists(sql, actor.tenant_id, req.kb_id);
  const subjectId = await normalizeAclSubjectId(sql, actor.tenant_id, subjectType, req.subject_id);

  const inserted = await sql`
    INSERT INTO knowledge_base_acl (tenant_id, kb_id, subject_type, subject_id, permission, created_by)
    VALUES (${actor.tenant_id}, ${req.kb_id}, ${subjectType}, ${subjectId}, ${permission}, ${actor.user_id})
    ON CONFLICT (tenant_id, kb_id, subject_type, subject_id, permission)
    DO UPDATE SET created_by = knowledge_base_acl.created_by
    RETURNING id
  `;
  const row = inserted[0];
  if (!row) throw AppError.internal('knowledge_base_acl upsert returned no row');
  const aclId = String(row.id);

  const authorization = await fetchPermission(sql, actor.tenant_id, aclId);
  await recordAuditEvent(sql, actor, 'knowledge_base_acl.grant', 'knowledge_base_acl', aclId, {
    kb_id: authorization.kb_id,
    kb_name: authorization.kb_name,
    subject_type: authorization.subject_type,
    subject_id: authorization.subject_id,
    permission: authorization.permission,
  });
  return c.json(authorization);
}

async function revokePermission(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'kb.manage');
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('ACL_REQUIRES_POSTGRES', '知识库授权需要启用 PostgreSQL');
  const aclId = c.req.param('acl_id')!;

  const existing = await fetchPermission(sql, actor.tenant_id, aclId);
  const result = await sql`
    DELETE FROM knowledge_base_acl WHERE tenant_id = ${actor.tenant_id} AND id = ${aclId}
  `;
  if (result.count === 0) {
    throw AppError.notFound('ACL_NOT_FOUND', '授权记录不存在或无权限');
  }
  await recordAuditEvent(sql, actor, 'knowledge_base_acl.revoke', 'knowledge_base_acl', aclId, {
    kb_id: existing.kb_id,
    kb_name: existing.kb_name,
    subject_type: existing.subject_type,
    subject_id: existing.subject_id,
    permission: existing.permission,
  });
  return c.json({ id: aclId, status: 'revoked' });
}

function normalizeAclSubjectType(value: string): string {
  const subjectType = (value ?? '').trim();
  if (subjectType === 'role' || subjectType === 'user') return subjectType;
  throw AppError.badRequest('ACL_SUBJECT_TYPE_INVALID', '授权对象类型只能是 role 或 user');
}

async function normalizeAclSubjectId(
  sql: Sql, tenantId: string, subjectType: string, raw: string,
): Promise<string> {
  const subject = (raw ?? '').trim();
  if (subject.length === 0) {
    throw AppError.badRequest('ACL_SUBJECT_EMPTY', '授权对象不能为空');
  }
  if (subjectType === 'role') {
    const roles = [
      'tenant_admin', 'tenant_owner', 'team_admin', 'data_admin',
      'user', 'analyst', 'end_user', 'viewer',
    ];
    if (roles.includes(subject)) return subject;
    throw AppError.badRequest(
      'ACL_ROLE_INVALID',
      '角色必须是 tenant_admin / team_admin / data_admin / user / analyst / end_user / viewer');
  }

  const rows = isUuid(subject)
    ? await sql`
        SELECT u.id
        FROM app_user u
        JOIN tenant_member tm
          ON tm.user_id = u.id
         AND tm.tenant_id = ${tenantId}
         AND tm.status = 'active'
        WHERE u.id = ${subject}
          AND u.status = 'active'
        LIMIT 1
      `
    : await sql`
        SELECT u.id
        FROM app_user u
        JOIN tenant_member tm
          ON tm.user_id = u.id
         AND tm.tenant_id = ${tenantId}
         AND tm.status = 'active'
        WHERE lower(u.email) = lower(${subject})
          AND u.status = 'active'
        LIMIT 1
      `;
  const row = rows[0];
  if (!row) {
    throw AppError.notFound('ACL_USER_NOT_FOUND', '授权用户不存在、未加入当前租户或未启用');
  }
  return String(row.id);
}

async function fetchPermission(
  sql: Sql, tenantId: string, aclId: string,
): Promise<KnowledgeBaseAuthorization> {
  const rows = await sql`
    SELECT acl.id, acl.tenant_id, acl.kb_id, kb.name AS kb_name,
           acl.subject_type, acl.subject_id, acl.permission, acl.created_by,
           COALESCE(NULLIF(u.name, ''), u.email) AS user_label,
           COALESCE(NULLIF(c.name, ''), c.email) AS created_by_label,
           acl.created_at
    FROM knowledge_base_acl acl
    JOIN knowledge_base kb
      ON kb.tenant_id = acl.tenant_id
     AND kb.id = acl.kb_id
    LEFT JOIN app_user u
      ON acl.subject_type = 'user'
     AND u.id::text = acl.subject_id
    LEFT JOIN app_user c
      ON c.id = acl.created_by
    WHERE acl.tenant_id = ${tenantId}
      AND acl.id = ${aclId}
  `;
  const row = rows[0];
  if (!row) throw AppError.notFound('ACL_NOT_FOUND', '授权记录不存在或无权限');
  return permissionFromRow(row);
}

function permissionFromRow(row: Record<string, unknown>): KnowledgeBaseAuthorization {
  const subjectType = String(row.subject_type);
  const subjectId = String(row.subject_id);
  const userLabel = (row.user_label as string | null) ?? null;
  const subjectLabel = subjectType === 'user' ? (userLabel ?? subjectId) : subjectId;
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    kb_id: String(row.kb_id),
    kb_name: String(row.kb_name),
    subject_type: subjectType,
    subject_id: subjectId,
    subject_label: subjectLabel,
    permission: String(row.permission),
    created_by: (row.created_by as string | null) ?? null,
    created_by_label: (row.created_by_label as string | null) ?? null,
    created_at: toRfc3339(new Date(row.created_at as Date | string)),
  };
}
