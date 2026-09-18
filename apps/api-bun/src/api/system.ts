// 移植自 apps/api-rs/src/api/system.rs
import { Hono } from 'hono';
import type { Context } from 'hono';
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
import {
  checkFailed, checkOpenAiCompatibleEndpoint, type DependencyCheck,
} from '../http/health.ts';

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
  const checkedAt = toRfc3339(new Date());
  const rerankerProbe = async (): Promise<DependencyCheck> => {
    if (!cfg.rag.rerank.enabled) return checkFailed('Reranker is disabled');
    const runtimeReranker = state.llm.reranker;
    if (!('probe' in runtimeReranker) || typeof runtimeReranker.probe !== 'function') {
      return checkFailed('Reranker does not expose a health probe');
    }
    try {
      await Promise.race([
        runtimeReranker.probe(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Reranker health check timed out')), 5_000)),
      ]);
      return { ok: true, reason: null, fields: {} };
    } catch (error) {
      return checkFailed((error as Error).message);
    }
  };

  const [generation, embedding, reranker] = await Promise.all([
    measuredProbe(() => checkOpenAiCompatibleEndpoint(
      cfg.rag.generation.useRealLlm, cfg.rag.generation.baseUrl,
      cfg.rag.generation.apiKey, 'LLM')),
    measuredProbe(() => checkOpenAiCompatibleEndpoint(
      cfg.rag.embedding.enabled, cfg.rag.embedding.baseUrl,
      cfg.rag.embedding.apiKey, 'Embedding')),
    measuredProbe(rerankerProbe),
  ]);
  const services: ModelService[] = [
    modelService('generation', '生成模型', '文本生成', providerFromUrl(cfg.rag.generation.baseUrl),
      cfg.rag.generation.model, cfg.rag.generation.baseUrl, cfg.rag.generation.useRealLlm,
      generation, checkedAt),
    modelService('embedding', '向量模型', '文本向量化', providerFromUrl(cfg.rag.embedding.baseUrl),
      cfg.rag.embedding.model, cfg.rag.embedding.baseUrl, cfg.rag.embedding.enabled,
      embedding, checkedAt),
    modelService('reranker', '重排模型', '检索结果重排', cfg.rag.rerank.provider,
      cfg.rag.rerank.model, cfg.rag.rerank.apiUrl ?? '', cfg.rag.rerank.enabled,
      reranker, checkedAt),
  ];
  return c.json({ checked_at: checkedAt, services });
}

async function listJobs(c: Context<AppEnv>) {
  const state = c.get('appState');
  requireSuperAdmin(c.get('actor'));
  const sql = state.sql;
  const checkedAt = toRfc3339(new Date());
  if (!sql) return c.json({ checked_at: checkedAt, queued: 0, running: 0, jobs: [] });

  const rows = await sql.unsafe(`
    SELECT active.*,
           CASE WHEN status = 'queued'
                THEN ROW_NUMBER() OVER (PARTITION BY status ORDER BY available_at, created_at)::int
                ELSE NULL END AS queue_position
    FROM (
      SELECT j.parse_job_id AS id, j.tenant_id, t.name AS tenant_name,
             CASE WHEN j.parser_config->>'job_kind' = 'ocr' THEN 'document_ocr'
                  ELSE 'document_parse' END AS kind,
             COALESCE(d.metadata->>'original_filename', d.title, d.storage_key) AS title,
             CASE WHEN j.status IN ('pending', 'ocr_queued') THEN 'queued' ELSE 'running' END AS status,
             CASE WHEN d.metadata->>'parse_progress' ~ '^[0-9]+$'
                  THEN (d.metadata->>'parse_progress')::int ELSE NULL END AS progress,
             j.attempt_count, j.max_attempts, j.worker_id, j.available_at,
             j.created_at, j.started_at, j.updated_at
      FROM document_parse_jobs j
      JOIN documents d ON d.id = j.doc_id AND d.latest_parse_job_id = j.parse_job_id
      JOIN tenant t ON t.id = j.tenant_id
      WHERE j.status IN ('pending', 'ocr_queued', 'running')
      UNION ALL
      SELECT v.id, v.tenant_id, COALESCE(t.name, '系统'), 'vector_' || v.operation,
             CASE WHEN v.operation = 'rebuild_index' THEN v.target_index
                  ELSE COALESCE(d.metadata->>'original_filename', d.title, v.doc_id::text) END,
             CASE WHEN v.status = 'pending' THEN 'queued' ELSE 'running' END,
             CASE WHEN v.metadata->>'progress' ~ '^[0-9]+$'
                  THEN (v.metadata->>'progress')::int ELSE NULL END,
             v.attempt_count, v.max_attempts, v.worker_id, v.available_at,
             v.created_at, v.started_at, v.updated_at
      FROM vector_jobs v
      LEFT JOIN tenant t ON t.id = v.tenant_id
      LEFT JOIN documents d ON d.id = v.doc_id
      WHERE v.status IN ('pending', 'running')
    ) active
    ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, available_at, created_at`);

  const jobs: JobSummary[] = rows.map((row) => ({
    id: String(row.id),
    tenant_id: row.tenant_id ? String(row.tenant_id) : '',
    tenant_name: String(row.tenant_name),
    kind: String(row.kind),
    title: String(row.title),
    status: row.status === 'running' ? 'running' : 'queued',
    progress: row.progress === null ? null : Number(row.progress),
    queue_position: row.queue_position === null ? null : Number(row.queue_position),
    attempt_count: Number(row.attempt_count ?? 0),
    max_attempts: Number(row.max_attempts ?? 0),
    worker_id: row.worker_id ? String(row.worker_id) : null,
    created_at: toRfc3339(new Date(row.created_at as Date | string)),
    started_at: row.started_at ? toRfc3339(new Date(row.started_at as Date | string)) : null,
    updated_at: toRfc3339(new Date(row.updated_at as Date | string)),
  }));
  return c.json({
    checked_at: checkedAt,
    queued: jobs.filter((job) => job.status === 'queued').length,
    running: jobs.filter((job) => job.status === 'running').length,
    jobs,
  });
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


interface MeasuredProbe {
  check: DependencyCheck;
  latency_ms: number;
}

async function measuredProbe(run: () => Promise<DependencyCheck>): Promise<MeasuredProbe> {
  const started = performance.now();
  const check = await run();
  return { check, latency_ms: Math.round(performance.now() - started) };
}

function modelService(
  id: string,
  name: string,
  role: string,
  provider: string,
  model: string,
  baseUrl: string,
  enabled: boolean,
  probe: MeasuredProbe,
  checkedAt: string,
): ModelService {
  return {
    id, name, role, provider, model, base_url: baseUrl, configured: enabled,
    status: enabled ? (probe.check.ok ? 'healthy' : 'unavailable') : 'disabled',
    latency_ms: enabled ? probe.latency_ms : null,
    checked_at: checkedAt,
    reason: probe.check.reason,
  };
}

function providerFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return raw;
  }
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



function configured(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}
