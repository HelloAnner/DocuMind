// 移植自 apps/api-rs/src/api/admin.rs
import { Hono } from 'hono';
import type { Context } from 'hono';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import type { KnowledgeBaseSummary, MemberSummary } from '../models/identity.ts';
import { recordAuditEvent } from '../auth/audit.ts';
import { requirePermission, requireTenantAdmin } from '../auth/permissions.ts';
import { newUuid } from '../infra/uuid.ts';
import { toRfc3339 } from '../infra/time.ts';
import { adminInvitationsRouter } from './admin_invitations.ts';
import { adminLogsRouter } from './admin_logs.ts';
import { adminPermissionsRouter } from './admin_permissions.ts';
import {
  CHUNKER_VERSION, kbNotFound, kbSummaryFromRow,
  normalizeKbName, normalizeKbStatus, normalizeTags, providerName,
  type KnowledgeBaseUpsert,
} from './admin_support.ts';

export function adminRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/admin/overview', overview);
  router.get('/api/admin/runtime-config', runtimeConfig);
  router.get('/api/admin/knowledge-bases', listKnowledgeBases);
  router.post('/api/admin/knowledge-bases', createKnowledgeBase);
  router.put('/api/admin/knowledge-bases/:kb_id', updateKnowledgeBase);
  router.delete('/api/admin/knowledge-bases/:kb_id', deleteKnowledgeBase);
  router.get('/api/admin/members', listMembers);
  router.route('/', adminInvitationsRouter());
  router.route('/', adminPermissionsRouter());
  router.route('/', adminLogsRouter());
  return router;
}

async function overview(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  const sql = state.sql;
  if (sql) {
    const rows = await sql`
      SELECT
        (SELECT COUNT(*) FROM documents WHERE tenant_id = ${actor.tenant_id}) AS doc_count,
        (SELECT COUNT(*) FROM documents WHERE tenant_id = ${actor.tenant_id} AND parse_status = 'indexed') AS indexed_doc_count,
        (SELECT COALESCE(SUM(chunk_count), 0) FROM documents WHERE tenant_id = ${actor.tenant_id}) AS chunk_count,
        (SELECT COUNT(*) FROM tenant_member WHERE tenant_id = ${actor.tenant_id} AND status = 'active') AS active_users,
        (SELECT COUNT(*) FROM documents WHERE tenant_id = ${actor.tenant_id} AND parse_status IN ('parse_failed', 'parse_low_confidence', 'ocr_pending', 'embedding_failed', 'parsing', 'parsed')) AS failed_docs,
        (SELECT COUNT(*)
           FROM document_parse_jobs j
           JOIN documents d ON d.id = j.doc_id
          WHERE j.tenant_id = ${actor.tenant_id}
            AND j.status IN ('pending', 'running')
            AND d.parse_status NOT IN ('indexed', 'parse_low_confidence', 'ocr_pending')) AS running_jobs
    `;
    const kbs = await sql`
      SELECT kb.name, kb.status,
             COUNT(DISTINCT d.id)::bigint AS doc_count,
             COALESCE(SUM(d.chunk_count), 0)::bigint AS chunk_count
      FROM knowledge_base kb
      LEFT JOIN documents d ON d.kb_id = kb.id AND d.tenant_id = kb.tenant_id
      WHERE kb.tenant_id = ${actor.tenant_id}
      GROUP BY kb.id
      ORDER BY kb.updated_at DESC
      LIMIT 8
    `;
    const row = rows[0]!;
    return c.json({
      doc_count: Number(row.doc_count),
      indexed_doc_count: Number(row.indexed_doc_count),
      chunk_count: Number(row.chunk_count),
      active_users: Number(row.active_users),
      failed_docs: Number(row.failed_docs),
      running_jobs: Number(row.running_jobs),
      knowledge_bases: kbs.map((kb) => ({
        name: String(kb.name),
        doc_count: Number(kb.doc_count ?? 0),
        chunk_count: Number(kb.chunk_count ?? 0),
        status: String(kb.status),
      })),
      alerts: [],
    });
  }
  return c.json({
    doc_count: 0, indexed_doc_count: 0, chunk_count: 0, active_users: 0,
    failed_docs: 0, running_jobs: 0, knowledge_bases: [], alerts: [],
  });
}

async function runtimeConfig(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'config.read');
  const cfg = state.config;
  // 与 Rust 一致：切片参数来自 RAG_* 环境变量（config.rag.chunking）
  const chunk = {
    target_chunk_tokens: cfg.rag.chunking.targetChunkTokens,
    max_chunk_tokens: cfg.rag.chunking.maxChunkTokens,
    hard_split_tokens: cfg.rag.chunking.hardSplitTokens,
    min_chunk_tokens: cfg.rag.chunking.minChunkTokens,
    overlap_tokens: cfg.rag.chunking.overlapTokens,
    max_table_rows_per_chunk: cfg.rag.chunking.maxTableRowsPerChunk,
    max_table_token_per_chunk: cfg.rag.chunking.maxTableTokenPerChunk,
  };
  return c.json({
    read_only: true,
    source: 'server_env',
    environment: cfg.environment,
    chunking: {
      strategy: 'structure_aware',
      chunker_version: CHUNKER_VERSION,
      target_chunk_tokens: chunk.target_chunk_tokens,
      max_chunk_tokens: chunk.max_chunk_tokens,
      hard_split_tokens: chunk.hard_split_tokens,
      min_chunk_tokens: chunk.min_chunk_tokens,
      overlap_tokens: chunk.overlap_tokens,
      max_table_rows_per_chunk: chunk.max_table_rows_per_chunk,
      max_table_token_per_chunk: chunk.max_table_token_per_chunk,
      preserve_table_structure: true,
      preserve_list_hierarchy: true,
      merge_short_blocks: true,
    },
    embedding: {
      enabled: cfg.rag.embedding.enabled,
      model: cfg.rag.embedding.model,
      base_url: cfg.rag.embedding.baseUrl,
      api_key_configured: configured(cfg.rag.embedding.apiKey),
      batch_size: cfg.rag.embedding.batchSize,
      dimension: cfg.rag.embedding.dimension,
      retry_max: cfg.rag.embedding.retryMax,
      worker_poll_ms: cfg.rag.embedding.workerPollMs,
      index_name: cfg.rag.embedding.indexName,
      index_alias: cfg.rag.embedding.indexAlias,
      index_schema_version: cfg.rag.embedding.indexSchemaVersion,
      queue: 'documind.embedding.pending',
      dead_letter_queue: 'documind.embedding.dead',
      canonical_vector_store: 'postgresql.chunk_embeddings.embedding_values',
      retrieval_store: 'elasticsearch',
    },
    search: {
      strategy: 'Dense + BM25 + RRF',
      dense_top_k: cfg.rag.retrieval.denseTopK,
      bm25_top_k: cfg.rag.retrieval.bm25TopK,
      rrf_top_k: cfg.rag.retrieval.rrfTopK,
      effective_top_k: cfg.rag.retrieval.effectiveTopK,
      rerank_enabled: cfg.rag.rerank.enabled,
      rerank_provider: cfg.rag.rerank.provider,
      rerank_model: cfg.rag.rerank.model,
      rerank_api_configured: configured(cfg.rag.rerank.apiUrl),
    },
    llm: {
      provider: providerName(cfg.rag.generation.baseUrl),
      use_real_llm: cfg.rag.generation.useRealLlm,
      model: cfg.rag.generation.model,
      base_url: cfg.rag.generation.baseUrl,
      api_key_configured: cfg.rag.generation.apiKey.trim().length > 0
        && cfg.rag.generation.apiKey !== 'ollama',
      temperature: cfg.rag.generation.temperature,
      max_output_tokens: cfg.rag.generation.maxOutputTokens,
      streaming_enabled: cfg.rag.generation.useRealLlm,
      rewrite_enabled: cfg.rag.rewrite.enabled,
      rewrite_model: cfg.rag.rewrite.model,
      verify_claims: cfg.rag.citation.verifyClaims,
      verify_consensus: cfg.rag.citation.verifyConsensus,
    },
    agent: {
      runtime: 'llm_react',
      reasoning_model: cfg.agent.reasoningModel,
      max_react_steps: cfg.agent.maxReactSteps,
      max_queries_per_step: cfg.agent.maxQueriesPerStep,
      max_history_turns: cfg.agent.maxHistoryTurns,
      max_history_chars: cfg.agent.maxHistoryChars,
      max_context_chars: cfg.agent.maxContextChars,
      max_repair_attempts: cfg.agent.maxRepairAttempts,
      total_timeout_seconds: cfg.agent.totalTimeoutSeconds,
    },
  });
}

async function listKnowledgeBases(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  const sql = state.sql;
  if (sql) {
    const rows = await sql`
      SELECT kb.id, kb.tenant_id, kb.name, kb.description, kb.status, kb.tags,
             COUNT(DISTINCT d.id)::bigint AS doc_count,
             COUNT(c.id)::bigint AS chunk_count,
             0::bigint AS query_count,
             kb.updated_at
      FROM knowledge_base kb
      LEFT JOIN documents d
             ON d.kb_id = kb.id
            AND d.tenant_id = kb.tenant_id
            AND d.parse_status <> 'deleted'
      LEFT JOIN chunks c
             ON c.doc_id = d.id
            AND d.latest_parse_job_id = c.parse_job_id
      WHERE kb.tenant_id = ${actor.tenant_id}
      GROUP BY kb.id
      ORDER BY kb.updated_at DESC
    `;
    return c.json(rows.map(kbSummaryFromRow));
  }
  const fallback: KnowledgeBaseSummary[] = [
    {
      id: state.config.defaultKbIds[0] ?? '00000000-0000-0000-0000-000000000000',
      tenant_id: actor.tenant_id, name: '产品文档库',
      description: '面向全公司的产品手册与白皮书集合', status: 'active', tags: ['产品'],
      doc_count: 3201, chunk_count: 4832, query_count: 1204, updated_at: toRfc3339(new Date()),
    },
    {
      id: newUuid(), tenant_id: actor.tenant_id, name: '销售资料库',
      description: '销售策略、报价单与合同模板', status: 'active', tags: ['销售'],
      doc_count: 1044, chunk_count: 2156, query_count: 540, updated_at: toRfc3339(new Date()),
    },
    {
      id: newUuid(), tenant_id: actor.tenant_id, name: '人力资源库',
      description: '员工手册、报销政策与规章制度', status: 'active', tags: ['人事'],
      doc_count: 328, chunk_count: 890, query_count: 231, updated_at: toRfc3339(new Date()),
    },
  ];
  return c.json(fallback);
}

async function createKnowledgeBase(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  requirePermission(actor, 'kb.create');
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('KB_REQUIRES_POSTGRES', '知识库管理需要启用 PostgreSQL');
  const req = await c.req.json() as KnowledgeBaseUpsert;
  const name = normalizeKbName(req.name);
  const status = normalizeKbStatus(req.status);
  const tags = normalizeTags(req.tags ?? []);
  const description = (req.description ?? '').trim().length > 0 ? req.description!.trim() : null;

  const created = await sql.begin(async (tx) => {
    const rows = await tx`
      INSERT INTO knowledge_base (tenant_id, name, description, status, tags, created_by, updated_at)
      VALUES (${actor.tenant_id}, ${name}, ${description}, ${status}, ${tags}, ${actor.user_id}, now())
      RETURNING id, tenant_id, name, description, status, tags,
                0::bigint AS doc_count, 0::bigint AS chunk_count, 0::bigint AS query_count,
                updated_at
    `;
    const row = rows[0];
    if (!row) throw AppError.internal('knowledge_base insert returned no row');
    for (const role of actor.roles) {
      await tx`
        INSERT INTO knowledge_base_acl (tenant_id, kb_id, subject_type, subject_id, permission, created_by)
        VALUES (${actor.tenant_id}, ${String(row.id)}, 'role', ${role}, 'manage', ${actor.user_id})
        ON CONFLICT (tenant_id, kb_id, subject_type, subject_id, permission) DO NOTHING
      `;
    }
    return row;
  });

  const summary = kbSummaryFromRow(created);
  await recordAuditEvent(sql, actor, 'knowledge_base.create', 'knowledge_base', summary.id, {
    name: summary.name, status: summary.status, tags: summary.tags,
  });
  return c.json(summary);
}

async function updateKnowledgeBase(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('KB_REQUIRES_POSTGRES', '知识库管理需要启用 PostgreSQL');
  const req = await c.req.json() as KnowledgeBaseUpsert;
  const kbId = c.req.param('kb_id')!;
  const name = normalizeKbName(req.name);
  const status = normalizeKbStatus(req.status);
  const tags = normalizeTags(req.tags ?? []);
  const description = (req.description ?? '').trim().length > 0 ? req.description!.trim() : null;

  const rows = await sql`
    WITH updated AS (
        UPDATE knowledge_base
        SET name = ${name}, description = ${description}, status = ${status}, tags = ${tags}, updated_at = now()
        WHERE tenant_id = ${actor.tenant_id} AND id = ${kbId}
        RETURNING id, tenant_id, name, description, status, tags, updated_at
    )
    SELECT kb.id, kb.tenant_id, kb.name, kb.description, kb.status, kb.tags,
           COALESCE(ds.doc_count, 0)::bigint AS doc_count,
           COALESCE(ds.chunk_count, 0)::bigint AS chunk_count,
           0::bigint AS query_count,
           kb.updated_at
    FROM updated kb
    LEFT JOIN (
        SELECT kb_id, COUNT(*)::bigint AS doc_count, COALESCE(SUM(chunk_count), 0)::bigint AS chunk_count
        FROM documents
        WHERE tenant_id = ${actor.tenant_id} AND kb_id = ${kbId}
        GROUP BY kb_id
    ) ds ON ds.kb_id = kb.id
  `;
  const row = rows[0];
  if (!row) throw kbNotFound();
  const summary = kbSummaryFromRow(row);
  await recordAuditEvent(sql, actor, 'knowledge_base.update', 'knowledge_base', summary.id, {
    name: summary.name, status: summary.status, tags: summary.tags,
  });
  return c.json(summary);
}

async function deleteKnowledgeBase(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('KB_REQUIRES_POSTGRES', '知识库管理需要启用 PostgreSQL');
  const kbId = c.req.param('kb_id')!;

  const result = await sql`
    DELETE FROM knowledge_base WHERE tenant_id = ${actor.tenant_id} AND id = ${kbId}
  `;
  if (result.count === 0) throw kbNotFound();
  await recordAuditEvent(sql, actor, 'knowledge_base.delete', 'knowledge_base', kbId, {});
  return c.json({ kb_id: kbId, status: 'deleted' });
}

async function listMembers(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  const sql = state.sql;
  if (sql) {
    const rows = await sql`
      SELECT u.id, COALESCE(u.email, u.login_id) AS email, u.name, tm.roles, tm.status,
             tm.joined_at, tm.last_seen_at, 0::bigint AS query_count
      FROM app_user u
      JOIN tenant_member tm ON tm.user_id = u.id
      WHERE tm.tenant_id = ${actor.tenant_id}
        AND tm.status <> 'removed'
        AND u.auth_provider <> 'api'
        AND NOT ('super_admin' = ANY(tm.roles))
      ORDER BY CASE WHEN 'tenant_admin' = ANY(tm.roles) THEN 0 ELSE 1 END,
               tm.joined_at DESC NULLS LAST
    `;
    const members: MemberSummary[] = [];
    for (const row of rows) {
      const roles = (row.roles as string[]) ?? [];
      const kbRows = await sql`
        SELECT DISTINCT kb.name FROM knowledge_base_acl acl
        JOIN knowledge_base kb ON kb.id = acl.kb_id
        WHERE acl.tenant_id = ${actor.tenant_id}
          AND (acl.subject_type = 'role' AND acl.subject_id = ANY(${roles})
            OR acl.subject_type = 'user' AND acl.subject_id = ${String(row.id)})
      `;
      members.push({
        id: String(row.id),
        email: String(row.email),
        name: (row.name as string | null) ?? null,
        roles,
        allowed_kb_names: kbRows.map((kbRow) => String(kbRow.name)),
        query_count: Number(row.query_count ?? 0),
        status: String(row.status),
        joined_at: optionalRfc3339(row.joined_at),
        last_seen_at: optionalRfc3339(row.last_seen_at),
      });
    }
    return c.json(members);
  }
  const now = toRfc3339(new Date());
  return c.json([
    { id: newUuid(), email: 'admin@documind.local', name: '企业管理员', roles: ['enterprise_admin'], allowed_kb_names: ['全部'], query_count: 156, status: 'active', joined_at: now, last_seen_at: now },
    { id: newUuid(), email: 'user@documind.local', name: '普通用户', roles: ['user'], allowed_kb_names: ['产品文档库', '销售资料库'], query_count: 89, status: 'active', joined_at: now, last_seen_at: now },
    { id: newUuid(), email: 'viewer@documind.local', name: '只读用户', roles: ['viewer'], allowed_kb_names: ['人力资源库'], query_count: 34, status: 'active', joined_at: now, last_seen_at: null },
    { id: newUuid(), email: 'zhangsan@company.com', name: '张三', roles: ['tenant_admin'], allowed_kb_names: ['全部'], query_count: 156, status: 'active', joined_at: now, last_seen_at: now },
    { id: newUuid(), email: 'lisi@company.com', name: '李四', roles: ['end_user'], allowed_kb_names: ['产品文档库', '销售资料库'], query_count: 89, status: 'active', joined_at: now, last_seen_at: now },
    { id: newUuid(), email: 'wangwu@company.com', name: '王五', roles: ['end_user'], allowed_kb_names: ['人力资源库'], query_count: 34, status: 'active', joined_at: now, last_seen_at: null },
  ] satisfies MemberSummary[]);
}

function configured(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

function optionalRfc3339(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toRfc3339(new Date(value as Date | string));
}
