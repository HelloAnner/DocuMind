// 移植自 apps/api-rs/src/api/system.rs 的向量索引相关 handler（拆分以控制单文件行数）
import { Hono } from 'hono';
import type { Context } from 'hono';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import type { AppState } from '../state.ts';
import { requireSuperAdmin } from '../auth/permissions.ts';
import { toRfc3339 } from '../infra/time.ts';
import { consistency, scheduleRebuild } from '../rag/vector_pipeline.ts';

export function systemVectorIndexesRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/system/vector-indexes', listVectorIndexes);
  router.get('/api/system/vector-indexes/reconcile', reconcileVectorIndex);
  router.post('/api/system/vector-indexes/rebuild', rebuildVectorIndex);
  return router;
}

async function listVectorIndexes(c: Context<AppEnv>) {
  const state = c.get('appState');
  requireSuperAdmin(c.get('actor'));
  const sql = state.sql;
  if (!sql) return c.json([]);

  const esDocCount = await elasticsearchIndexCount(state);
  const esUrl = state.config.elasticsearchUrl;
  const snapshot = esUrl ? await consistency(sql, state.config.rag.embedding, esUrl) : null;
  const indexConsistent = snapshot ? Boolean(snapshot.consistent) : false;
  const physicalIndex = snapshot ? snapshot.physical_index : null;
  const embedding = state.config.rag.embedding;

  // 用 unsafe 显式复用 $1/$2：postgres.js 的模板插值会为同一值生成不同占位符，
  // 导致 GROUP BY 里的 COALESCE(e.embedding_model, $n) 与 SELECT 中不匹配。
  const rows = await sql.unsafe(`
    SELECT t.id AS tenant_id,
           t.name AS tenant_name,
           kb.id AS kb_id,
           kb.name AS kb_name,
           COALESCE(e.embedding_model, $1) AS embedding_model,
           COALESCE(MAX(e.embedding_dim), $2)::int AS embedding_dim,
           COUNT(DISTINCT d.id) FILTER (WHERE d.parse_status = 'indexed')::bigint AS indexed_documents,
           COUNT(DISTINCT d.id) FILTER (
               WHERE d.parse_status IN ('uploaded', 'parsing', 'chunked', 'embedding')
           )::bigint AS building_documents,
           COUNT(DISTINCT d.id) FILTER (
               WHERE d.parse_status IN ('parse_failed', 'parse_low_confidence', 'ocr_pending', 'embedding_failed', 'parsed')
           )::bigint AS degraded_documents,
           COUNT(DISTINCT c.id)::bigint AS chunks,
           COUNT(DISTINCT e.chunk_id) FILTER (
               WHERE e.status = 'completed' AND e.index_status = 'indexed'
           )::bigint AS embedded_chunks,
           COUNT(DISTINCT e.chunk_id) FILTER (
               WHERE e.status <> 'completed' OR e.index_status = 'failed'
           )::bigint AS failed_embeddings,
           MAX(e.indexed_at) AS last_indexed_at
    FROM knowledge_base kb
    JOIN tenant t ON t.id = kb.tenant_id
    LEFT JOIN documents d
           ON d.kb_id = kb.id
          AND d.tenant_id = kb.tenant_id
          AND d.parse_status <> 'deleted'
    LEFT JOIN chunks c
           ON c.doc_id = d.id
          AND c.tenant_id = d.tenant_id
          AND c.kb_id = d.kb_id
          AND c.parse_job_id = d.latest_parse_job_id
    LEFT JOIN chunk_embeddings e
           ON e.chunk_id = c.id
          AND e.embedding_model = $1
    GROUP BY t.id, t.name, kb.id, kb.name, COALESCE(e.embedding_model, $1)
    ORDER BY t.name ASC, kb.name ASC`,
    [embedding.model, embedding.dimension]);

  return c.json(rows.map((row) => {
    const chunks = Number(row.chunks ?? 0);
    const embeddedChunks = Number(row.embedded_chunks ?? 0);
    const buildingDocuments = Number(row.building_documents ?? 0);
    const degradedDocuments = Number(row.degraded_documents ?? 0);
    const failedEmbeddings = Number(row.failed_embeddings ?? 0);
    const status = buildingDocuments > 0
      ? 'building'
      : degradedDocuments > 0 || failedEmbeddings > 0
        || embeddedChunks < chunks || !indexConsistent
        ? 'degraded' : 'healthy';
    const kbId = String(row.kb_id);
    const embeddingModel = String(row.embedding_model);
    const lastIndexedAt = row.last_indexed_at as Date | string | null;
    return {
      id: `${kbId}:${embeddingModel}`,
      name: embedding.indexName,
      alias: embedding.indexAlias,
      physical_index: physicalIndex,
      tenant_id: String(row.tenant_id),
      tenant: String(row.tenant_name),
      kb_id: kbId,
      kb_name: String(row.kb_name),
      embedding_model: embeddingModel,
      index_version: `${embedding.indexAlias}:${embeddingModel}`,
      dimension: Number(row.embedding_dim ?? 0),
      documents: Number(row.indexed_documents ?? 0),
      building_documents: buildingDocuments,
      degraded_documents: degradedDocuments,
      chunks,
      embedded_chunks: embeddedChunks,
      es_documents: esDocCount,
      index_consistent: indexConsistent,
      status,
      lastIndexed: lastIndexedAt ? toRfc3339(new Date(lastIndexedAt)) : null,
    };
  }));
}

async function reconcileVectorIndex(c: Context<AppEnv>) {
  const state = c.get('appState');
  requireSuperAdmin(c.get('actor'));
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DATABASE_REQUIRED', '向量索引对账需要 PostgreSQL');
  const esUrl = state.config.elasticsearchUrl;
  if (!esUrl) {
    throw AppError.badRequest('ELASTICSEARCH_REQUIRED', '向量索引对账需要 Elasticsearch');
  }
  return c.json(await consistency(sql, state.config.rag.embedding, esUrl));
}

async function rebuildVectorIndex(c: Context<AppEnv>) {
  const state = c.get('appState');
  requireSuperAdmin(c.get('actor'));
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DATABASE_REQUIRED', '向量索引重建需要 PostgreSQL');
  if (!state.config.elasticsearchUrl) {
    throw AppError.badRequest('ELASTICSEARCH_REQUIRED', '向量索引重建需要 Elasticsearch');
  }
  const [jobId, targetIndex] = await scheduleRebuild(sql, state.config.rag.embedding);
  return c.json({ job_id: jobId, target_index: targetIndex, status: 'pending' });
}

async function elasticsearchIndexCount(state: AppState): Promise<number> {
  const baseUrl = state.config.elasticsearchUrl;
  if (!baseUrl) return 0;
  const url = `${baseUrl.replace(/\/+$/, '')}/${state.config.rag.embedding.indexAlias}/_count`;
  const response = await fetch(url);
  if (!response.ok) {
    throw AppError.internal(`elasticsearch _count returned HTTP ${response.status}`);
  }
  const body = await response.json() as Record<string, unknown>;
  return typeof body.count === 'number' ? body.count : 0;
}
