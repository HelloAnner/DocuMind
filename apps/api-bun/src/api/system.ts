// 移植自 apps/api-rs/src/api/system.rs
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Sql } from 'postgres';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import type { AppState } from '../state.ts';
import type {
  JobSummary, ModelService, SystemUserSummary, TenantSummary,
} from '../models/identity.ts';
import { requireSuperAdmin } from '../auth/permissions.ts';
import { newUuid } from '../infra/uuid.ts';
import { toRfc3339 } from '../infra/time.ts';
import { systemVectorIndexesRouter } from './system_vector_indexes.ts';

// system_tenants.rs / system_tenant_invitations.rs / 向量索引部分的实现拆到独立文件，
// 这里转发导出并在 systemRouter 中挂载；各 router 只注册互不冲突的路径。
export { createTenant, updateTenant, requestTenantDeletion } from './system_tenants.ts';
export { generateAdminInvitation } from './system_tenant_invitations.ts';

export function systemRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/system/overview', overview);
  router.get('/api/system/tenants', listTenants);
  router.get('/api/system/tenants/:id', getTenant);
  router.get('/api/system/users', listUsers);
  router.get('/api/system/models', listModels);
  router.get('/api/system/jobs', listJobs);
  router.get('/api/system/audit', listAudit);
  router.get('/api/system/settings', settings);
  router.get('/api/system/tenant-integrity', tenantIntegrity);
  router.route('/', systemVectorIndexesRouter());
  return router;
}

async function overview(c: Context<AppEnv>) {
  const state = c.get('appState');
  requireSuperAdmin(c.get('actor'));
  const sql = state.sql;
  if (sql) {
    const rows = await sql`
      SELECT
        (SELECT COUNT(*) FROM tenant) AS tenant_count,
        (SELECT COUNT(*) FROM app_user WHERE auth_provider <> 'api') AS user_count,
        (SELECT COUNT(*) FROM knowledge_base) AS kb_count,
        (SELECT COUNT(*) FROM documents) AS doc_count,
        (SELECT COUNT(*) FROM documents WHERE parse_status = 'indexed') AS indexed_doc_count,
        (SELECT COALESCE(SUM(chunk_count), 0) FROM documents) AS chunk_count,
        ((SELECT COUNT(*)
            FROM document_parse_jobs j
            JOIN documents d ON d.id = j.doc_id
           WHERE j.status IN ('pending', 'running')
             AND d.parse_status NOT IN ('indexed', 'parse_low_confidence', 'ocr_pending'))
         + (SELECT COUNT(*) FROM vector_jobs WHERE status IN ('pending', 'running'))) AS running_jobs,
        (SELECT COUNT(*) FROM documents WHERE parse_status IN ('parse_failed', 'parse_low_confidence', 'ocr_pending', 'embedding_failed', 'parsing', 'parsed')) AS failed_docs
    `;
    const row = rows[0]!;
    return c.json({
      tenant_count: Number(row.tenant_count),
      user_count: Number(row.user_count),
      kb_count: Number(row.kb_count),
      doc_count: Number(row.doc_count),
      indexed_doc_count: Number(row.indexed_doc_count),
      chunk_count: Number(row.chunk_count),
      running_jobs: Number(row.running_jobs),
      failed_docs: Number(row.failed_docs),
      models: runtimeModelsJson(state),
      alerts: [],
    });
  }
  return c.json({
    tenant_count: 0, user_count: 0, kb_count: 0, doc_count: 0,
    indexed_doc_count: 0, chunk_count: 0, running_jobs: 0, failed_docs: 0,
    models: runtimeModelsJson(state), alerts: [],
  });
}

async function tenantIntegrity(c: Context<AppEnv>) {
  const state = c.get('appState');
  requireSuperAdmin(c.get('actor'));
  const sql = state.sql;
  if (!sql) return c.json({ ok: true, checks: {} });

  const documentRows = await sql`
    SELECT COUNT(*) AS count
    FROM documents d
    JOIN knowledge_base kb ON kb.id = d.kb_id
    WHERE d.tenant_id <> kb.tenant_id
  `;
  const chunkRows = await sql`
    SELECT COUNT(*) AS count
    FROM chunks c
    JOIN documents d ON d.id = c.doc_id
    WHERE c.tenant_id <> d.tenant_id OR c.kb_id <> d.kb_id
  `;
  const embeddingRows = await sql`
    SELECT COUNT(*) AS count
    FROM chunk_embeddings e
    JOIN chunks c ON c.id = e.chunk_id
    WHERE e.tenant_id <> c.tenant_id OR e.kb_id <> c.kb_id OR e.doc_id <> c.doc_id
  `;
  const anchorRows = await sql`
    SELECT COUNT(*) AS count
    FROM document_source_anchors a
    JOIN documents d ON d.id = a.doc_id
    WHERE a.tenant_id <> d.tenant_id
  `;

  const documentsKbTenantMismatch = Number(documentRows[0]?.count ?? 0);
  const chunksDocScopeMismatch = Number(chunkRows[0]?.count ?? 0);
  const embeddingsChunkScopeMismatch = Number(embeddingRows[0]?.count ?? 0);
  const anchorsDocScopeMismatch = Number(anchorRows[0]?.count ?? 0);
  const ok = documentsKbTenantMismatch === 0
    && chunksDocScopeMismatch === 0
    && embeddingsChunkScopeMismatch === 0
    && anchorsDocScopeMismatch === 0;
  return c.json({
    ok,
    checks: {
      documents_kb_tenant_mismatch: documentsKbTenantMismatch,
      chunks_doc_scope_mismatch: chunksDocScopeMismatch,
      embeddings_chunk_scope_mismatch: embeddingsChunkScopeMismatch,
      anchors_doc_scope_mismatch: anchorsDocScopeMismatch,
    },
  });
}

async function listTenants(c: Context<AppEnv>) {
  const state = c.get('appState');
  requireSuperAdmin(c.get('actor'));
  const sql = state.sql;
  if (sql) {
    const rows = await sql`
      SELECT t.id, t.name, t.slug, t.status, t.plan,
             COALESCE((SELECT COUNT(*) FROM tenant_member m WHERE m.tenant_id = t.id AND m.status = 'active' AND NOT EXISTS (SELECT 1 FROM platform_admin pa WHERE pa.user_id = m.user_id AND pa.status = 'active')), 0) AS member_count,
             COALESCE((SELECT COUNT(*) FROM knowledge_base kb WHERE kb.tenant_id = t.id), 0) AS kb_count,
             COALESCE((SELECT COUNT(*) FROM documents d WHERE d.tenant_id = t.id), 0) AS doc_count,
             0::bigint AS monthly_queries,
             COALESCE((SELECT COUNT(*) FROM tenant_member m WHERE m.tenant_id = t.id AND m.status = 'active' AND 'tenant_admin' = ANY(m.roles)), 0) AS active_admin_count,
             COALESCE((SELECT COUNT(*) FROM tenant_invitation i WHERE i.tenant_id = t.id AND i.status = 'pending' AND i.expires_at > NOW()), 0) AS pending_invitation_count,
             t.updated_at
      FROM tenant t
      ORDER BY t.created_at DESC
    `;
    const summaries: TenantSummary[] = rows.map((row) => ({
      id: String(row.id), name: String(row.name), slug: String(row.slug),
      status: String(row.status), plan: String(row.plan),
      member_count: Number(row.member_count ?? 0),
      kb_count: Number(row.kb_count ?? 0),
      doc_count: Number(row.doc_count ?? 0),
      monthly_queries: Number(row.monthly_queries ?? 0),
      active_admin_count: Number(row.active_admin_count ?? 0),
      pending_invitation_count: Number(row.pending_invitation_count ?? 0),
      updated_at: toRfc3339(new Date(row.updated_at as Date | string)),
    }));
    return c.json(summaries);
  }
  const fallback: TenantSummary = {
    id: state.config.defaultTenantId, name: 'Acme Corp', slug: 'acme',
    status: 'active', plan: 'enterprise', member_count: 3, kb_count: 3,
    doc_count: 128, monthly_queries: 18203, active_admin_count: 1,
    pending_invitation_count: 0, updated_at: toRfc3339(new Date()),
  };
  return c.json([fallback]);
}

async function getTenant(c: Context<AppEnv>) {
  const state = c.get('appState');
  requireSuperAdmin(c.get('actor'));
  const id = c.req.param('id')!;
  const sql = state.sql;
  if (sql) {
    const rows = await sql`
      SELECT id, name, slug, status, plan FROM tenant WHERE id = ${id}
    `;
    const row = rows[0];
    if (!row) throw AppError.notFound('TENANT_NOT_FOUND', '租户不存在');
    return c.json({
      id: String(row.id), name: String(row.name), slug: String(row.slug),
      status: String(row.status), plan: String(row.plan),
    });
  }
  return c.json({
    id, name: state.config.defaultTenantName, slug: state.config.defaultTenantSlug,
    status: 'active', plan: 'enterprise',
  });
}

async function listUsers(c: Context<AppEnv>) {
  const state = c.get('appState');
  requireSuperAdmin(c.get('actor'));
  const sql = state.sql;
  if (sql) {
    const rows = await sql`
      SELECT id, login_id, COALESCE(email, '') AS email, name, status
      FROM app_user WHERE auth_provider <> 'api' ORDER BY created_at DESC
    `;
    const users: SystemUserSummary[] = [];
    for (const row of rows) {
      const id = String(row.id);
      const tenantRows = await sql`
        SELECT t.name || '(' || UNNEST(tm.roles) || ')' AS label
        FROM tenant_member tm
        JOIN tenant t ON t.id = tm.tenant_id
        WHERE tm.user_id = ${id}
          AND NOT EXISTS (
            SELECT 1 FROM platform_admin pa
            WHERE pa.user_id = tm.user_id AND pa.status = 'active'
          )
      `;
      const tenants = tenantRows.map((tenantRow) => String(tenantRow.label));
      const adminRows = await sql`
        SELECT EXISTS(SELECT 1 FROM platform_admin WHERE user_id = ${id} AND status = 'active') AS active
      `;
      if (adminRows[0]?.active) tenants.push('平台(超级管理员)');
      users.push({
        id, login_id: String(row.login_id), email: String(row.email),
        name: (row.name as string | null) ?? null, status: String(row.status),
        tenants, last_login_at: null,
      });
    }
    return c.json(users);
  }
  return c.json([
    { id: newUuid(), login_id: 'ops', email: 'ops@documind.local', name: 'Ops', status: 'active', tenants: ['Acme(super_admin)'], last_login_at: null },
    { id: newUuid(), login_id: 'admin', email: 'admin@documind.local', name: 'Admin', status: 'active', tenants: ['Acme(enterprise_admin)'], last_login_at: null },
    { id: newUuid(), login_id: 'dev', email: 'dev@documind.local', name: 'Dev', status: 'active', tenants: ['Acme(admin)'], last_login_at: null },
  ] satisfies SystemUserSummary[]);
}

async function listModels(c: Context<AppEnv>) {
  const state = c.get('appState');
  requireSuperAdmin(c.get('actor'));
  const cfg = state.config;
  const services: ModelService[] = [
    {
      id: newUuid(), name: 'chat-default', model: cfg.rag.generation.model,
      base_url: cfg.rag.generation.baseUrl, api_key_tail: tail(cfg.rag.generation.apiKey),
      status: cfg.rag.generation.useRealLlm ? 'configured' : 'mock',
      throughput: 'not_measured', latency: 'not_measured',
    },
    {
      id: newUuid(), name: 'embedding-default', model: cfg.rag.embedding.model,
      base_url: cfg.rag.embedding.baseUrl,
      api_key_tail: cfg.rag.embedding.apiKey ? tail(cfg.rag.embedding.apiKey) : 'unset',
      status: cfg.rag.embedding.enabled ? 'configured' : 'disabled',
      throughput: 'not_measured', latency: 'not_measured',
    },
    {
      id: newUuid(), name: 'reranker-default', model: cfg.rag.rerank.model,
      base_url: cfg.rag.rerank.apiUrl ?? '',
      api_key_tail: cfg.rag.rerank.apiKey ? tail(cfg.rag.rerank.apiKey) : 'unset',
      status: rerankerStatus(state),
      throughput: 'not_measured', latency: 'not_measured',
    },
  ];
  return c.json(services);
}

async function listJobs(c: Context<AppEnv>) {
  const state = c.get('appState');
  requireSuperAdmin(c.get('actor'));
  const sql = state.sql;
  if (sql) {
    await reconcileTerminalDocumentJobs(sql);
    const rows = await sql`
      SELECT id, tenant_id, tenant_name, kind, status, progress, created_at
      FROM (
          SELECT j.parse_job_id AS id, j.tenant_id, t.slug AS tenant_name,
                 'document_parse'::text AS kind, j.status,
                 COALESCE((d.metadata->>'parse_progress')::int, 0) AS progress,
                 j.created_at
          FROM document_parse_jobs j
          JOIN tenant t ON t.id = j.tenant_id
          JOIN documents d ON d.id = j.doc_id
          UNION ALL
          SELECT v.id,
                 COALESCE(v.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 COALESCE(t.slug, 'system'),
                 'vector_' || v.operation,
                 v.status,
                 CASE v.status
                     WHEN 'pending' THEN 0
                     WHEN 'running' THEN 50
                     ELSE 100
                 END,
                 v.created_at
          FROM vector_jobs v
          LEFT JOIN tenant t ON t.id = v.tenant_id
      ) jobs
      ORDER BY created_at DESC
      LIMIT 100
    `;
    const summaries: JobSummary[] = rows.map((row) => ({
      id: String(row.id), tenant_id: String(row.tenant_id),
      tenant_name: String(row.tenant_name), kind: String(row.kind),
      status: String(row.status), progress: Number(row.progress ?? 0),
      created_at: toRfc3339(new Date(row.created_at as Date | string)),
    }));
    return c.json(summaries);
  }
  return c.json([]);
}

async function settings(c: Context<AppEnv>) {
  const state = c.get('appState');
  requireSuperAdmin(c.get('actor'));
  const cfg = state.config;
  return c.json({
    read_only: true,
    environment: cfg.environment,
    service: {
      host: cfg.serverHost, port: cfg.serverPort,
      base_path: '/documind', health_path: '/api/health',
    },
    auth: {
      login_mode: cfg.authLoginMode,
      token_expire_hours: cfg.authTokenExpireHours,
      portal_base_url: cfg.portalBaseUrl,
      portal_exchange_endpoint: cfg.portalExchangeEndpoint,
      local_login_enabled: cfg.authLoginMode === 'local',
      portal_login_enabled: cfg.authLoginMode === 'portal',
    },
    storage: {
      database_configured: configured(cfg.databaseUrl),
      redis_configured: configured(cfg.redisUrl),
      rabbitmq_configured: configured(cfg.rabbitmqUrl),
      elasticsearch_configured: configured(cfg.elasticsearchUrl),
      object_storage_provider: cfg.objectStorageProvider,
      object_storage_endpoint_configured: configured(cfg.objectStorageEndpoint),
      object_storage_region: cfg.objectStorageRegion,
      object_storage_bucket: cfg.objectStorageBucket,
      object_storage_force_path_style: cfg.objectStorageForcePathStyle,
      object_storage_tls_verify: cfg.objectStorageTlsVerify,
      object_storage_presign_expire_seconds: cfg.objectStoragePresignExpireSeconds,
    },
    deployment: {
      host_alias: 'documind', root: '/opt/documind', current: '/opt/documind/current',
      releases: '/opt/documind/releases/<timestamp>', shared: '/opt/documind/shared',
      env_file: '/opt/documind/shared/.env',
      log_file: '/opt/documind/shared/logs/documind-8089.log',
      containers: [
        'documind-postgres', 'documind-redis', 'documind-rabbitmq',
        'documind-elasticsearch', 'documind-minio',
      ],
    },
  });
}

async function listAudit(c: Context<AppEnv>) {
  const state = c.get('appState');
  requireSuperAdmin(c.get('actor'));
  const sql = state.sql;
  if (!sql) return c.json([]);

  const rawQuery = c.req.query('q');
  const trimmed = rawQuery ? rawQuery.trim() : '';
  const search = trimmed.length > 0 ? `%${trimmed}%` : null;
  const rawLimit = Number(c.req.query('limit'));
  const limit = Math.min(500, Math.max(1,
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.trunc(rawLimit) : 200));

  const rows = await sql`
    SELECT a.id,
           COALESCE(t.name, 'system') AS tenant_name,
           COALESCE(u.name, u.email, a.actor_role, 'anonymous') AS actor_name,
           COALESCE(a.actor_role, 'anonymous') AS actor_role,
           a.action,
           COALESCE(a.resource_type, '') AS resource_type,
           COALESCE(a.resource_id, '') AS resource_id,
           COALESCE(a.ip, '') AS ip,
           a.detail,
           a.created_at
    FROM audit_log a
    LEFT JOIN tenant t ON t.id = a.tenant_id
    LEFT JOIN app_user u ON u.id = a.actor_user_id
    WHERE ${search}::text IS NULL
       OR a.action ILIKE ${search}
       OR COALESCE(a.resource_type, '') ILIKE ${search}
       OR COALESCE(a.resource_id, '') ILIKE ${search}
       OR COALESCE(u.name, '') ILIKE ${search}
       OR COALESCE(u.email, '') ILIKE ${search}
    ORDER BY a.created_at DESC
    LIMIT ${limit}
  `;
  return c.json(rows.map((row) => {
    const resourceType = String(row.resource_type);
    const resourceId = String(row.resource_id);
    return {
      id: String(row.id),
      time: toRfc3339(new Date(row.created_at as Date | string)),
      tenant: String(row.tenant_name),
      user: String(row.actor_name),
      role: String(row.actor_role),
      action: String(row.action),
      resource_type: resourceType,
      resource_id: resourceId,
      resource: `${resourceType}:${resourceId}`,
      ip: String(row.ip),
      detail: row.detail,
    };
  }));
}

async function reconcileTerminalDocumentJobs(sql: Sql): Promise<void> {
  await sql`
    UPDATE document_parse_jobs j
    SET status = 'completed',
        completed_at = COALESCE(j.completed_at, NOW())
    FROM documents d
    WHERE d.id = j.doc_id
      AND j.status IN ('pending', 'running')
      AND d.parse_status IN ('indexed', 'parse_low_confidence')
  `;
}

function runtimeModelsJson(state: AppState): Array<Record<string, string>> {
  const cfg = state.config;
  return [
    {
      name: 'chat-default', model: cfg.rag.generation.model,
      status: cfg.rag.generation.useRealLlm ? 'configured' : 'mock',
    },
    {
      name: 'embedding-default', model: cfg.rag.embedding.model,
      status: cfg.rag.embedding.enabled ? 'configured' : 'disabled',
    },
    { name: 'reranker-default', model: cfg.rag.rerank.model, status: rerankerStatus(state) },
  ];
}

function rerankerStatus(state: AppState): string {
  if (!state.config.rag.rerank.enabled) return 'disabled';
  if (state.config.rag.rerank.apiUrl) return 'configured';
  return 'lexical_fallback';
}

function tail(secret: string): string {
  return [...secret].slice(-4).join('');
}

function configured(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}
