// 移植自 apps/api-rs/src/api/vector_diagnostics.rs
import { Hono } from 'hono';
import type { AppEnv } from '../http/types.ts';
import { requirePermission } from '../auth/permissions.ts';
import { toRfc3339 } from '../infra/time.ts';

export function vectorDiagnosticsRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/diagnostics/vector-indexes', listVectorIndexesHandler);
  return router;
}

async function listVectorIndexesHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'audit.read');
  if (actor.allowed_kb_ids.length === 0) return c.json([]);
  const sql = state.sql;
  if (!sql) return c.json([]);

  const rows = await sql`
    SELECT t.id AS tenant_id,
           t.name AS tenant_name,
           kb.id AS kb_id,
           kb.name AS kb_name,
           COUNT(DISTINCT d.id) FILTER (WHERE d.parse_status = 'indexed')::bigint
               AS indexed_documents,
           COUNT(DISTINCT d.id) FILTER (
               WHERE d.parse_status IN ('uploaded', 'parsing', 'chunked', 'embedding')
           )::bigint AS building_documents,
           COUNT(DISTINCT d.id) FILTER (
               WHERE d.parse_status IN (
                   'parse_failed', 'parse_low_confidence', 'ocr_pending',
                   'embedding_failed', 'parsed'
               )
           )::bigint AS degraded_documents,
           COUNT(DISTINCT c.id)::bigint AS chunks,
           COUNT(DISTINCT c.id) FILTER (
               WHERE d.parse_status = 'indexed'
                 AND e.status = 'completed'
                 AND e.index_status = 'indexed'
           )::bigint AS searchable_chunks,
           COUNT(DISTINCT e.chunk_id) FILTER (
               WHERE e.status = 'completed' AND e.index_status = 'indexed'
           )::bigint AS embedded_chunks,
           COUNT(DISTINCT e.chunk_id) FILTER (
               WHERE e.status <> 'completed' OR e.index_status = 'failed'
           )::bigint AS failed_embeddings,
           COUNT(DISTINCT c.id) FILTER (
               WHERE d.parse_status = 'excluded_from_search'
           )::bigint AS excluded_chunks,
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
          AND e.embedding_model = ${state.config.rag.embedding.model}
    WHERE kb.tenant_id = ${actor.tenant_id}
      AND kb.id = ANY(${actor.allowed_kb_ids})
    GROUP BY t.id, t.name, kb.id, kb.name
    ORDER BY kb.name ASC
  `;
  const embedding = state.config.rag.embedding;
  return c.json(rows.map((row) => {
    const chunks = Number(row.chunks ?? 0);
    const searchableChunks = Number(row.searchable_chunks ?? 0);
    const buildingDocuments = Number(row.building_documents ?? 0);
    const degradedDocuments = Number(row.degraded_documents ?? 0);
    const failedEmbeddings = Number(row.failed_embeddings ?? 0);
    const status = buildingDocuments > 0 ? 'building'
      : (degradedDocuments > 0 || failedEmbeddings > 0) ? 'degraded' : 'healthy';
    const kbId = String(row.kb_id);
    const lastIndexedAt = row.last_indexed_at;
    return {
      id: `${kbId}:${embedding.model}`,
      name: embedding.indexName,
      alias: embedding.indexAlias,
      tenant_id: String(row.tenant_id),
      tenant: String(row.tenant_name),
      kb_id: kbId,
      kb_name: String(row.kb_name),
      embedding_model: embedding.model,
      index_version: `${embedding.indexAlias}:${embedding.model}`,
      dimension: embedding.dimension,
      documents: Number(row.indexed_documents ?? 0),
      building_documents: buildingDocuments,
      degraded_documents: degradedDocuments,
      chunks,
      searchable_chunks: searchableChunks,
      embedded_chunks: Number(row.embedded_chunks ?? 0),
      failed_embeddings: failedEmbeddings,
      excluded_chunks: Number(row.excluded_chunks ?? 0),
      status,
      lastIndexed: lastIndexedAt ? toRfc3339(new Date(lastIndexedAt as Date | string)) : null,
    };
  }));
}
