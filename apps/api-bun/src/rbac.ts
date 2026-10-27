// DocuMind RBAC：权限覆盖、目录、矩阵、本地接口与 Portal 内部接口。
// 统一模型见 docs/权限设计方案/统一RBAC权限体系设计方案.txt。
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Sql } from 'postgres';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.ts';
import type { AppEnv } from './http/types.ts';
import type { CurrentActor } from './models/identity.ts';
import { recordAuditEvent } from './auth/audit.ts';
import { derivePermissions, isDocumindAdmin, requireTenantAdmin } from './auth/permissions.ts';
import {
  RBAC_ACTIONS,
  buildCatalog,
  buildFeatureCells,
  buildKbCells,
  deniedNativePoints,
  featureById,
  kbActions,
  featureGates,
  kbGates,
  nativePoints,
  validateTarget,
  type KbLike,
  type RbacAction,
  type RbacCell,
  type RbacEffect,
  type RbacGate,
  type RbacMatrix,
  type RbacOverride,
  type RbacSubject,
} from './rbac_core.ts';

type SubjectRow = {
  id: string;
  username: string;
  name: string;
  status: string;
  roles: string[];
  member_status: string;
  portal_user_id: string | null;
};

type OverrideRow = {
  entity_type: string;
  entity_id: string;
  action: RbacAction;
  effect: RbacEffect;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireSql(ctx: Context<AppEnv>): Sql {
  const sql = ctx.get('appState').sql;
  if (!sql) throw AppError.internal('数据库不可用');
  return sql;
}

function requireToken(ctx: Context<AppEnv>): void {
  const expected = process.env.PORTAL_INTERNAL_TOKEN ?? '';
  const provided = ctx.req.header('X-Portal-Internal-Token') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
    throw AppError.notFound('NOT_FOUND', 'Not found');
  }
}

function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw AppError.badRequest('INVALID_FIELD', `无效字段 ${label}`);
  }
  return value.trim();
}

function uuid(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!UUID_RE.test(result)) throw AppError.badRequest('INVALID_FIELD', `无效字段 ${label}`);
  return result;
}

function actionOf(value: unknown): RbacAction {
  if (value === 'view' || value === 'edit' || value === 'manage') return value;
  throw AppError.badRequest('INVALID_ACTION', '动作只能是 view / edit / manage');
}

function effectOf(value: unknown): RbacEffect | null {
  if (value === null || value === undefined) return null;
  if (value === 'allow' || value === 'deny') return value;
  throw AppError.badRequest('INVALID_EFFECT', 'effect 只能是 allow / deny / null');
}

async function loadOverrides(sql: Sql, tenantId: string, subjectId: string): Promise<RbacOverride[]> {
  const rows = await sql<OverrideRow[]>`
    SELECT entity_type, entity_id, action, effect
    FROM permission_override
    WHERE tenant_id = ${tenantId}
      AND subject_type = 'user'
      AND subject_id = ${subjectId}
  `;
  return rows.map((row) => ({
    entity_type: String(row.entity_type),
    entity_id: String(row.entity_id),
    action: row.action as RbacAction,
    effect: row.effect as RbacEffect,
  }));
}

async function loadKbs(sql: Sql, tenantId: string): Promise<KbLike[]> {
  const rows = await sql`
    SELECT id, name, status FROM knowledge_base
    WHERE tenant_id = ${tenantId} AND status <> 'archived'
    ORDER BY name ASC
  `;
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    status: String(row.status),
  }));
}

async function loadAclKbIds(sql: Sql, tenantId: string, userId: string, roles: string[]): Promise<Set<string>> {
  const rows = await sql`
    SELECT DISTINCT kb_id FROM knowledge_base_acl
    WHERE tenant_id = ${tenantId}
      AND (
        (subject_type = 'user' AND subject_id = ${userId}::text)
        OR (subject_type = 'role' AND subject_id = ANY(${roles}::text[]))
      )
  `;
  return new Set(rows.map((row) => String(row.kb_id)));
}

async function loadSubject(sql: Sql, tenantId: string, subjectId: string): Promise<SubjectRow> {
  const rows = await sql<SubjectRow[]>`
    SELECT u.id, u.login_id AS username,
           COALESCE(NULLIF(u.name, ''), u.login_id) AS name,
           u.status, tm.roles, tm.status AS member_status,
           pim.portal_user_id
    FROM tenant_member tm
    JOIN app_user u ON u.id = tm.user_id
    LEFT JOIN portal_tenant_mapping ptm ON ptm.tenant_id = tm.tenant_id
    LEFT JOIN portal_identity_mapping pim
      ON pim.local_user_id = u.id AND pim.portal_tenant_id = ptm.portal_tenant_id
    WHERE tm.tenant_id = ${tenantId}
      AND tm.user_id = ${subjectId}
      AND tm.status <> 'removed'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw AppError.notFound('SUBJECT_NOT_FOUND', '成员不存在');
  return {
    id: String(row.id),
    username: String(row.username),
    name: String(row.name),
    status: String(row.status) === 'active' && String(row.member_status) === 'active' ? 'active' : 'suspended',
    roles: (row.roles as string[]) ?? [],
    member_status: String(row.member_status),
    portal_user_id: row.portal_user_id ? String(row.portal_user_id) : null,
  };
}

function subjectOf(row: SubjectRow): RbacSubject {
  const roles = row.roles.length > 0 ? row.roles : ['user'];
  return {
    id: row.id,
    portal_user_id: row.portal_user_id,
    username: row.username,
    name: row.name,
    role: roles[0] ?? 'user',
    roles,
    status: row.status,
    managed: row.portal_user_id !== null,
  };
}

async function matrixFor(sql: Sql, tenantId: string, subject: SubjectRow): Promise<RbacMatrix> {
  const roles = subject.roles.length > 0 ? subject.roles : ['user'];
  const permissions = new Set(derivePermissions(roles));
  const admin = isDocumindAdmin(roles);
  const overrides = await loadOverrides(sql, tenantId, subject.id);
  const kbs = await loadKbs(sql, tenantId);
  const aclKbIds = admin ? new Set<string>() : await loadAclKbIds(sql, tenantId, subject.id, roles);
  const cells: RbacCell[] = [
    ...buildFeatureCells(permissions, overrides),
    ...buildKbCells({ kbs, permissions, admin, aclKbIds, overrides }),
  ];
  const gates: RbacGate[] = [...featureGates(permissions), ...kbGates(permissions, overrides)];
  return {
    subject: subjectOf(subject),
    baseline_label: `角色 ${roles.join(' + ')}`,
    cells,
    gates,
  };
}

function cellFor(params: {
  subject: SubjectRow;
  kbs: KbLike[];
  aclKbIds: Set<string>;
  overrides: RbacOverride[];
  type: string;
  id: string;
  action: RbacAction;
}): RbacCell {
  const roles = params.subject.roles.length > 0 ? params.subject.roles : ['user'];
  const permissions = new Set(derivePermissions(roles));
  const admin = isDocumindAdmin(roles);
  if (params.type === 'feature') {
    const feature = featureById(params.id);
    const points = feature ? (feature.actions[params.action] ?? []) : [];
    const baseline = points.length > 0 && points.every((point) => permissions.has(point));
    const own = params.overrides.find(
      (item) => item.entity_type === 'feature' && item.entity_id === params.id && item.action === params.action,
    );
    if (own?.effect === 'deny') {
      return { type: 'feature', id: params.id, action: params.action, allow: false, source: 'deny' };
    }
    return {
      type: 'feature', id: params.id, action: params.action,
      allow: own?.effect === 'allow' || baseline,
      source: own?.effect === 'allow' ? 'allow' : 'role',
    };
  }
  const denied = deniedNativePoints(params.overrides);
  const effective = new Set([...permissions].filter((point) => !denied.has(point)));
  const gate = effective.has(
    params.action === 'view' ? 'kb.read' : params.action === 'edit' ? 'kb.write' : 'kb.manage',
  );
  const baselineVisible = admin || params.aclKbIds.has(params.id);
  const own = params.overrides.find(
    (item) => item.entity_type === 'kb' && item.entity_id === params.id && item.action === params.action,
  );
  if (own?.effect === 'deny') {
    return { type: 'kb', id: params.id, action: params.action, allow: false, source: 'deny' };
  }
  return {
    type: 'kb', id: params.id, action: params.action,
    allow: gate && (own?.effect === 'allow' || baselineVisible),
    source: own?.effect === 'allow' ? 'allow' : 'role',
  };
}

async function writeAudit(
  sql: Sql,
  input: {
    tenantId: string;
    actorUserId: string | null;
    actorRole: string;
    action: string;
    resourceId: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await sql`
    INSERT INTO audit_log (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
    VALUES (${input.tenantId}, ${input.actorUserId}, ${input.actorRole},
            ${input.action}, 'permission_override', ${input.resourceId},
            ${sql.json(input.detail as import('postgres').JSONValue)})
  `;
}

async function applyCell(
  sql: Sql,
  input: {
    tenantId: string;
    subjectId: string;
    type: string;
    id: string;
    action: RbacAction;
    effect: RbacEffect | null;
    actorUserId: string | null;
    actorRole: string;
    enforceOwnScope: CurrentActor | null;
  },
): Promise<RbacCell> {
  const subject = await loadSubject(sql, input.tenantId, input.subjectId);
  const kbs = await loadKbs(sql, input.tenantId);
  if (input.type === 'kb' && !kbs.some((kb) => kb.id === input.id)) {
    throw AppError.notFound('ENTITY_NOT_FOUND', '知识库不存在');
  }
  const validation = validateTarget(input.type, input.id, input.action, new Set(kbs.map((kb) => kb.id)));
  if (validation) {
    throw AppError.badRequest('INVALID_TARGET', validation === 'action_not_supported' ? '该实体不支持这个动作' : '实体不存在');
  }
  if (input.type === 'feature' && input.effect === 'allow') {
    throw AppError.badRequest(
      'FEATURE_GRANT_NOT_SUPPORTED',
      '功能权限不支持个人允许；请在成员管理中调整角色',
    );
  }
  const roles = subject.roles.length > 0 ? subject.roles : ['user'];
  const aclKbIds = isDocumindAdmin(roles) ? new Set<string>() : await loadAclKbIds(sql, input.tenantId, subject.id, roles);
  const beforeOverrides = await loadOverrides(sql, input.tenantId, subject.id);

  // 防止管理员把资源 allow 授予自己本来没有的动作（Portal 来源由 Portal 管理员兜底）。
  if (input.enforceOwnScope && input.effect === 'allow' && input.type === 'kb') {
    const actorKbs = await loadKbs(sql, input.tenantId);
    const actorAcl = isDocumindAdmin(input.enforceOwnScope.roles)
      ? new Set<string>()
      : await loadAclKbIds(sql, input.tenantId, input.enforceOwnScope.user_id, input.enforceOwnScope.roles);
    const actorOverrides = await loadOverrides(sql, input.tenantId, input.enforceOwnScope.user_id);
    const actions = kbActions({
      kbs: actorKbs,
      permissions: new Set(input.enforceOwnScope.permissions),
      admin: isDocumindAdmin(input.enforceOwnScope.roles),
      aclKbIds: actorAcl,
      overrides: actorOverrides,
    }).get(input.id);
    if (!actions?.has(input.action)) {
      throw AppError.forbiddenWith('CANNOT_GRANT_BEYOND_OWN_SCOPE', '不能授予自己没有的资源权限');
    }
  }

  if (input.effect === null) {
    await sql`
      DELETE FROM permission_override
      WHERE tenant_id = ${input.tenantId} AND subject_type = 'user'
        AND subject_id = ${subject.id} AND entity_type = ${input.type}
        AND entity_id = ${input.id} AND action = ${input.action}
    `;
  } else {
    await sql`
      INSERT INTO permission_override
        (tenant_id, subject_type, subject_id, entity_type, entity_id, action, effect, updated_by)
      VALUES (${input.tenantId}, 'user', ${subject.id}, ${input.type}, ${input.id},
              ${input.action}, ${input.effect}, ${input.actorUserId})
      ON CONFLICT (tenant_id, subject_type, subject_id, entity_type, entity_id, action)
      DO UPDATE SET effect = EXCLUDED.effect, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    `;
  }

  const afterOverrides = await loadOverrides(sql, input.tenantId, subject.id);
  const before = cellFor({
    subject, kbs, aclKbIds, overrides: beforeOverrides,
    type: input.type, id: input.id, action: input.action,
  });
  const after = cellFor({
    subject, kbs, aclKbIds, overrides: afterOverrides,
    type: input.type, id: input.id, action: input.action,
  });
  await writeAudit(sql, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: input.effect === null ? 'rbac.override.reset' : 'rbac.override.set',
    resourceId: subject.id,
    detail: {
      subject_id: subject.id,
      type: input.type,
      id: input.id,
      action: input.action,
      effect: input.effect,
      before,
      after,
    },
  });
  return after;
}

/** 每个请求只查一次覆盖；没有覆盖时完全走原来的角色逻辑，零额外开销。 */
export async function applyActorOverrides(sql: Sql, actor: CurrentActor): Promise<CurrentActor> {
  const overrides = await loadOverrides(sql, actor.tenant_id, actor.user_id);
  if (overrides.length === 0) return actor;
  const permissions = new Set(actor.permissions);
  const denied = deniedNativePoints(overrides);
  const effective = [...permissions].filter((point) => !denied.has(point));
  const kbs = await loadKbs(sql, actor.tenant_id);
  const roles = actor.roles.length > 0 ? actor.roles : ['user'];
  const admin = isDocumindAdmin(roles);
  const aclKbIds = admin ? new Set<string>() : await loadAclKbIds(sql, actor.tenant_id, actor.user_id, roles);
  const actions = kbActions({ kbs, permissions, admin, aclKbIds, overrides });
  const allowed = kbs.filter((kb) => actions.get(kb.id)?.has('view')).map((kb) => kb.id);
  const kbActionMap: Record<string, RbacAction[]> = {};
  for (const [kbId, set] of actions) kbActionMap[kbId] = [...set];
  return {
    ...actor,
    permissions: effective.sort(),
    allowed_kb_ids: allowed,
    kb_actions: kbActionMap,
  };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function catalogHandler(ctx: Context<AppEnv>) {
  const sql = requireSql(ctx);
  const actor = ctx.get('actor');
  requireTenantAdmin(actor);
  return ctx.json(buildCatalog(await loadKbs(sql, actor.tenant_id)));
}

async function subjectsHandler(ctx: Context<AppEnv>) {
  const sql = requireSql(ctx);
  const actor = ctx.get('actor');
  requireTenantAdmin(actor);
  const rows = await sql`
    SELECT u.id, u.login_id AS username,
           COALESCE(NULLIF(u.name, ''), u.login_id) AS name,
           u.status, tm.roles, tm.status AS member_status,
           pim.portal_user_id
    FROM tenant_member tm
    JOIN app_user u ON u.id = tm.user_id
    LEFT JOIN portal_tenant_mapping ptm ON ptm.tenant_id = tm.tenant_id
    LEFT JOIN portal_identity_mapping pim
      ON pim.local_user_id = u.id AND pim.portal_tenant_id = ptm.portal_tenant_id
    WHERE tm.tenant_id = ${actor.tenant_id} AND tm.status <> 'removed'
    ORDER BY CASE WHEN 'tenant_admin' = ANY(tm.roles) THEN 0 ELSE 1 END,
             COALESCE(NULLIF(u.name, ''), u.login_id), u.login_id
  `;
  return ctx.json({
    items: rows.map((row) => subjectOf({
      id: String(row.id), username: String(row.username), name: String(row.name),
      status: String(row.status) === 'active' && String(row.member_status) === 'active' ? 'active' : 'suspended',
      roles: (row.roles as string[]) ?? [], member_status: String(row.member_status),
      portal_user_id: row.portal_user_id ? String(row.portal_user_id) : null,
    })),
  });
}

async function matrixHandler(ctx: Context<AppEnv>) {
  const sql = requireSql(ctx);
  const actor = ctx.get('actor');
  requireTenantAdmin(actor);
  const subject = await loadSubject(sql, actor.tenant_id, uuid(ctx.req.query('subject_id'), 'subject_id'));
  return ctx.json(await matrixFor(sql, actor.tenant_id, subject));
}

async function setCellHandler(ctx: Context<AppEnv>) {
  const sql = requireSql(ctx);
  const actor = ctx.get('actor');
  requireTenantAdmin(actor);
  const body = await ctx.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) throw AppError.badRequest('INVALID_JSON', '请求体必须是 JSON 对象');
  const type = text(body.type, 'type', 32);
  const id = text(body.id, 'id', 256);
  const action = actionOf(body.action);
  const effect = effectOf(body.effect);
  const cell = await applyCell(sql, {
    tenantId: actor.tenant_id,
    subjectId: uuid(body.subject_id, 'subject_id'),
    type, id, action, effect,
    actorUserId: actor.user_id,
    actorRole: actor.roles[0] ?? 'tenant_admin',
    enforceOwnScope: actor,
  });
  return ctx.json({ cell });
}

async function resetHandler(ctx: Context<AppEnv>) {
  const sql = requireSql(ctx);
  const actor = ctx.get('actor');
  requireTenantAdmin(actor);
  const subjectId = uuid(ctx.req.query('subject_id'), 'subject_id');
  const subject = await loadSubject(sql, actor.tenant_id, subjectId);
  const removed = await sql`
    DELETE FROM permission_override
    WHERE tenant_id = ${actor.tenant_id} AND subject_type = 'user' AND subject_id = ${subject.id}
    RETURNING entity_type
  `;
  await writeAudit(sql, {
    tenantId: actor.tenant_id,
    actorUserId: actor.user_id,
    actorRole: actor.roles[0] ?? 'tenant_admin',
    action: 'rbac.override.reset',
    resourceId: subject.id,
    detail: { subject_id: subject.id, removed: removed.length, scope: 'all' },
  });
  return ctx.json({ removed: removed.length });
}

async function migrateLegacyHandler(ctx: Context<AppEnv>) {
  const sql = requireSql(ctx);
  const actor = ctx.get('actor');
  requireTenantAdmin(actor);
  const dryRun = ctx.req.query('dry_run') === 'true';
  const candidates = await sql`
    SELECT acl.id, acl.kb_id, acl.subject_id, acl.permission, acl.created_by, acl.created_at
    FROM knowledge_base_acl acl
    WHERE acl.tenant_id = ${actor.tenant_id}
      AND acl.subject_type = 'user'
      AND acl.subject_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  `;
  if (dryRun) return ctx.json({ dry_run: true, candidates: candidates.length, migrated: 0 });
  let migrated = 0;
  await sql.begin(async (tx) => {
    for (const row of candidates) {
      const action = row.permission === 'read' ? 'view' : row.permission === 'write' ? 'edit' : 'manage';
      const result = await tx`
        INSERT INTO permission_override
          (tenant_id, subject_type, subject_id, entity_type, entity_id, action, effect, updated_by)
        VALUES (${actor.tenant_id}, 'user', ${String(row.subject_id)}, 'kb', ${String(row.kb_id)},
                ${action}, 'allow', ${row.created_by ?? null})
        ON CONFLICT (tenant_id, subject_type, subject_id, entity_type, entity_id, action) DO NOTHING
        RETURNING entity_id
      `;
      migrated += result.length;
    }
  });
  if (migrated > 0) {
    await writeAudit(sql, {
      tenantId: actor.tenant_id,
      actorUserId: actor.user_id,
      actorRole: actor.roles[0] ?? 'tenant_admin',
      action: 'rbac.migrate_legacy',
      resourceId: 'knowledge_base_acl',
      detail: { candidates: candidates.length, migrated },
    });
  }
  return ctx.json({ dry_run: false, candidates: candidates.length, migrated });
}

async function pruneHandler(ctx: Context<AppEnv>) {
  const sql = requireSql(ctx);
  const actor = ctx.get('actor');
  requireTenantAdmin(actor);
  const dryRun = ctx.req.query('dry_run') === 'true';
  const stale = await sql`
    SELECT entity_id FROM permission_override
    WHERE tenant_id = ${actor.tenant_id} AND entity_type = 'kb'
      AND entity_id NOT IN (SELECT id::text FROM knowledge_base WHERE tenant_id = ${actor.tenant_id})
  `;
  if (dryRun) return ctx.json({ dry_run: true, stale: stale.length, removed: 0 });
  const removed = await sql`
    DELETE FROM permission_override
    WHERE tenant_id = ${actor.tenant_id} AND entity_type = 'kb'
      AND entity_id NOT IN (SELECT id::text FROM knowledge_base WHERE tenant_id = ${actor.tenant_id})
    RETURNING entity_id
  `;
  return ctx.json({ dry_run: false, stale: stale.length, removed: removed.length });
}

export function rbacRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/v1/rbac/catalog', catalogHandler);
  router.get('/api/v1/rbac/subjects', subjectsHandler);
  router.get('/api/v1/rbac/matrix', matrixHandler);
  router.put('/api/v1/rbac/matrix', setCellHandler);
  router.delete('/api/v1/rbac/matrix', resetHandler);
  router.post('/api/v1/rbac/migrate-legacy', migrateLegacyHandler);
  router.post('/api/v1/rbac/prune', pruneHandler);
  return router;
}

// ---------------------------------------------------------------------------
// Portal 内部接口：只接受服务令牌，不参与本地 JWT / SSO 鉴权。
// ---------------------------------------------------------------------------

async function portalTenant(sql: Sql, portalTenantId: string): Promise<string> {
  const rows = await sql`
    SELECT tenant_id FROM portal_tenant_mapping WHERE portal_tenant_id = ${portalTenantId} LIMIT 1
  `;
  if (!rows[0]) throw AppError.notFound('TENANT_NOT_LINKED', '该企业空间尚未关联本系统');
  return String(rows[0].tenant_id);
}

async function portalActorId(
  sql: Sql, portalTenantId: string, portalUserId: string | null,
): Promise<string | null> {
  if (!portalUserId) return null;
  const rows = await sql`
    SELECT local_user_id FROM portal_identity_mapping
    WHERE portal_tenant_id = ${portalTenantId} AND portal_user_id = ${portalUserId} LIMIT 1
  `;
  return rows[0] ? String(rows[0].local_user_id) : null;
}

function internalContext(ctx: Context<AppEnv>): {
  sql: Sql;
  tenantId: Promise<string>;
  portalTenantId: string;
  actorId: Promise<string | null>;
} {
  requireToken(ctx);
  const sql = requireSql(ctx);
  const portalTenantId = uuid(ctx.req.query('portal_tenant_id'), 'portal_tenant_id');
  const portalUserId = ctx.req.header('X-Portal-Actor') ?? null;
  return {
    sql,
    portalTenantId,
    tenantId: portalTenant(sql, portalTenantId),
    actorId: portalActorId(sql, portalTenantId, portalUserId && UUID_RE.test(portalUserId) ? portalUserId : null),
  };
}

async function internalCatalog(ctx: Context<AppEnv>) {
  const { sql } = internalContext(ctx);
  const tenantId = await portalTenant(sql, uuid(ctx.req.query('portal_tenant_id'), 'portal_tenant_id'));
  return ctx.json(buildCatalog(await loadKbs(sql, tenantId)));
}

async function internalSubjects(ctx: Context<AppEnv>) {
  const { sql } = internalContext(ctx);
  const tenantId = await portalTenant(sql, uuid(ctx.req.query('portal_tenant_id'), 'portal_tenant_id'));
  const rows = await sql`
    SELECT u.id, u.login_id AS username,
           COALESCE(NULLIF(u.name, ''), u.login_id) AS name,
           u.status, tm.roles, tm.status AS member_status,
           pim.portal_user_id
    FROM tenant_member tm
    JOIN app_user u ON u.id = tm.user_id
    LEFT JOIN portal_tenant_mapping ptm ON ptm.tenant_id = tm.tenant_id
    LEFT JOIN portal_identity_mapping pim
      ON pim.local_user_id = u.id AND pim.portal_tenant_id = ptm.portal_tenant_id
    WHERE tm.tenant_id = ${tenantId} AND tm.status <> 'removed'
    ORDER BY CASE WHEN 'tenant_admin' = ANY(tm.roles) THEN 0 ELSE 1 END,
             COALESCE(NULLIF(u.name, ''), u.login_id), u.login_id
  `;
  return ctx.json({
    items: rows.map((row) => subjectOf({
      id: String(row.id), username: String(row.username), name: String(row.name),
      status: String(row.status) === 'active' && String(row.member_status) === 'active' ? 'active' : 'suspended',
      roles: (row.roles as string[]) ?? [], member_status: String(row.member_status),
      portal_user_id: row.portal_user_id ? String(row.portal_user_id) : null,
    })),
  });
}

async function internalMatrix(ctx: Context<AppEnv>) {
  const { sql } = internalContext(ctx);
  const tenantId = await portalTenant(sql, uuid(ctx.req.query('portal_tenant_id'), 'portal_tenant_id'));
  const subject = await loadSubject(sql, tenantId, uuid(ctx.req.query('subject_id'), 'subject_id'));
  return ctx.json(await matrixFor(sql, tenantId, subject));
}

async function internalSetCell(ctx: Context<AppEnv>) {
  const { sql, actorId } = internalContext(ctx);
  const portalTenantId = uuid(ctx.req.query('portal_tenant_id'), 'portal_tenant_id');
  const tenantId = await portalTenant(sql, portalTenantId);
  const body = await ctx.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) throw AppError.badRequest('INVALID_JSON', '请求体必须是 JSON 对象');
  const cell = await applyCell(sql, {
    tenantId,
    subjectId: uuid(body.subject_id, 'subject_id'),
    type: text(body.type, 'type', 32),
    id: text(body.id, 'id', 256),
    action: actionOf(body.action),
    effect: effectOf(body.effect),
    actorUserId: await actorId,
    actorRole: 'portal_admin',
    enforceOwnScope: null,
  });
  return ctx.json({ cell });
}

async function internalReset(ctx: Context<AppEnv>) {
  const { sql, actorId } = internalContext(ctx);
  const portalTenantId = uuid(ctx.req.query('portal_tenant_id'), 'portal_tenant_id');
  const tenantId = await portalTenant(sql, portalTenantId);
  const subject = await loadSubject(sql, tenantId, uuid(ctx.req.query('subject_id'), 'subject_id'));
  const removed = await sql`
    DELETE FROM permission_override
    WHERE tenant_id = ${tenantId} AND subject_type = 'user' AND subject_id = ${subject.id}
    RETURNING entity_type
  `;
  await writeAudit(sql, {
    tenantId,
    actorUserId: await actorId,
    actorRole: 'portal_admin',
    action: 'rbac.override.reset',
    resourceId: subject.id,
    detail: { subject_id: subject.id, removed: removed.length, scope: 'all', via: 'portal' },
  });
  return ctx.json({ removed: removed.length });
}

export function portalRbacRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/portal/rbac/v1/catalog', internalCatalog);
  router.get('/api/portal/rbac/v1/subjects', internalSubjects);
  router.get('/api/portal/rbac/v1/matrix', internalMatrix);
  router.put('/api/portal/rbac/v1/matrix', internalSetCell);
  router.delete('/api/portal/rbac/v1/matrix', internalReset);
  return router;
}
