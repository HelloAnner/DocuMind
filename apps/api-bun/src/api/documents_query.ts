// 移植自 apps/api-rs/src/api/documents.rs —— 文档列表与详情查询
import type { Context } from 'hono';
import { AppError } from '../errors.ts';
import { requirePermission } from '../auth/permissions.ts';
import type { AppEnv } from '../http/types.ts';
import { requiredSql } from './documents_access.ts';
import { pathParam } from './documents_support.ts';
import { documentSummaryFromRow, fetchBlocks, fetchChunks, fetchCleanedBlocks, fetchParseJob,
  fetchDocumentSummary, fetchTables, renderDocumentPreview } from './documents_chunks.ts';
import type { DocumentDetail, DocumentListQuery } from './documents_types.ts';

/** Rust: DocumentListQuery（UUID 解析失败时 axum 返回 400） */
export function documentListQuery(c: Context<AppEnv>): DocumentListQuery {
  const rawKbId = c.req.query('kb_id');
  if (rawKbId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawKbId)) {
    throw AppError.badRequest('BAD_REQUEST', 'query 参数无效');
  }
  const rawPage = Number.parseInt(c.req.query('page') ?? '1', 10);
  const rawPageSize = Number.parseInt(c.req.query('page_size') ?? c.req.query('limit') ?? '25', 10);
  if (!Number.isFinite(rawPage) || rawPage < 1 || !Number.isFinite(rawPageSize) || rawPageSize < 1) {
    throw AppError.badRequest('BAD_REQUEST', 'query 参数无效');
  }
  return {
    kb_id: rawKbId ?? null,
    status: c.req.query('status') ?? null,
    q: c.req.query('q') ?? null,
    page: rawPage,
    page_size: Math.min(100, rawPageSize),
  };
}

/** Rust: list_documents */
export async function listDocuments(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'document.upload');
  const sql = requiredSql(state, '文档列表查询需要启用 PostgreSQL 数据库连接');
  const query = documentListQuery(c);
  const trimmed = query.q?.trim();
  const search = trimmed ? `%${trimmed}%` : null;
  const offset = (query.page - 1) * query.page_size;
  const filters = [actor.tenant_id, query.kb_id, query.status, search];

  const where = `d.tenant_id = $1
      AND ($2::uuid IS NULL OR d.kb_id = $2)
      AND (
        $3::text IS NULL OR $3 = 'all' OR d.parse_status = $3
        OR ($3 = 'done' AND d.parse_status IN ('parsed', 'cleaned', 'chunked', 'indexed'))
        OR ($3 = 'failed' AND d.parse_status IN (
            'parse_failed', 'parse_low_confidence', 'ocr_pending',
            'embedding_failed', 'parsing', 'parsed'
        ))
      )
      AND ($4::text IS NULL OR d.title ILIKE $4
        OR COALESCE(d.metadata->>'original_filename', d.storage_key) ILIKE $4)`;

  const [countRows, rows] = await Promise.all([
    sql.unsafe(
      `SELECT COUNT(*)::bigint AS total
       FROM documents d
       WHERE ${where}`,
      filters,
    ),
    sql.unsafe(
      `SELECT d.id AS doc_id, d.kb_id, kb.name AS kb_name, d.title,
              COALESCE(d.metadata->>'original_filename', d.storage_key) AS file_name,
              d.file_type, 'application/octet-stream' AS mime_type,
              d.file_size_bytes AS file_size, COALESCE(d.file_sha256, '') AS file_sha256,
              d.parse_status, d.parse_version, d.latest_parse_job_id, j.quality_score,
              d.chunk_count, COALESCE((j.parser_config->>'table_count')::int, 0) AS table_count,
              COALESCE((j.parser_config->>'page_count')::int, NULL)::int AS page_count,
              d.created_at AS uploaded_at, d.updated_at
       FROM documents d
       JOIN knowledge_base kb ON kb.id = d.kb_id
       LEFT JOIN document_parse_jobs j ON j.parse_job_id = d.latest_parse_job_id
       WHERE ${where}
       ORDER BY d.updated_at DESC
       LIMIT $5 OFFSET $6`,
      [...filters, query.page_size, offset],
    ),
  ]);

  return c.json({
    items: rows.map(documentSummaryFromRow),
    total: Number(countRows[0]?.total ?? 0),
    page: query.page,
    page_size: query.page_size,
  });
}

/** Rust: get_document */
export async function getDocument(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'document.upload');
  const sql = requiredSql(state, '文档详情查询需要启用 PostgreSQL 数据库连接');
  const docId = pathParam(c, 'doc_id');

  const document = await fetchDocumentSummary(sql, actor.tenant_id, docId);
  const latestJob = document.latest_parse_job_id === null
    ? null
    : await fetchParseJob(sql, document.latest_parse_job_id);
  const blocks = await fetchBlocks(sql, docId, document.latest_parse_job_id);
  const cleanedBlocks = await fetchCleanedBlocks(sql, docId, document.latest_parse_job_id);
  const chunks = await fetchChunks(sql, docId, document.latest_parse_job_id);
  const tables = await fetchTables(sql, docId, document.latest_parse_job_id);
  const preview = renderDocumentPreview(document, latestJob, blocks);

  const body: DocumentDetail = {
    document,
    latest_job: latestJob,
    preview,
    blocks,
    cleaned_blocks: cleanedBlocks,
    chunks,
    tables,
  };
  return c.json(body);
}

export async function getDocumentDiagnostics(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'document.upload');
  const sql = requiredSql(state, '文档诊断需要启用 PostgreSQL 数据库连接');
  const document = await fetchDocumentSummary(sql, actor.tenant_id, pathParam(c, 'doc_id'));
  const parseJobId = document.latest_parse_job_id;
  if (parseJobId === null) {
    return c.json({
      document_id: document.doc_id, parse_status: document.parse_status,
      quality_score: null, pages: document.page_count ?? 0, covered_pages: 0,
      page_coverage: 0, blocks: 0, block_types: {}, bbox_blocks: 0,
      bbox_coverage: 0, text_layer_blocks: 0, ocr_blocks: 0, tables: 0, warnings: [],
    });
  }
  const [counts, types, tables, latestJob] = await Promise.all([
    sql.unsafe(
      `SELECT COUNT(*)::int AS blocks,
              COUNT(*) FILTER (WHERE metadata->'bbox' IS NOT NULL
                                AND metadata->'bbox' <> 'null'::jsonb)::int AS bbox_blocks,
              COUNT(*) FILTER (WHERE metadata->'metadata'->>'extraction_method' = 'text_layer')::int AS text_layer_blocks,
              COUNT(*) FILTER (WHERE metadata->'metadata'->>'extraction_method' = 'ocr')::int AS ocr_blocks,
              COUNT(DISTINCT page)::int AS covered_pages
       FROM document_blocks b
       LEFT JOIN LATERAL generate_series(
         b.page_range[1], b.page_range[array_length(b.page_range, 1)]
       ) AS page ON TRUE
       WHERE b.tenant_id = \$1 AND b.doc_id = \$2 AND b.parse_job_id = \$3`,
      [actor.tenant_id, document.doc_id, parseJobId],
    ),
    sql.unsafe(
      `SELECT block_type, COUNT(*)::int AS count
       FROM document_blocks
       WHERE tenant_id = \$1 AND doc_id = \$2 AND parse_job_id = \$3
       GROUP BY block_type`,
      [actor.tenant_id, document.doc_id, parseJobId],
    ),
    sql.unsafe(
      `SELECT COUNT(*)::int AS count FROM document_tables
       WHERE tenant_id = \$1 AND doc_id = \$2 AND parse_job_id = \$3`,
      [actor.tenant_id, document.doc_id, parseJobId],
    ),
    fetchParseJob(sql, parseJobId),
  ]);
  const count = (counts[0] ?? {}) as Record<string, unknown>;
  const blocks = Number(count.blocks ?? 0);
  const bboxBlocks = Number(count.bbox_blocks ?? 0);
  const pages = document.page_count ?? 0;
  const coveredPages = Number(count.covered_pages ?? 0);
  return c.json({
    document_id: document.doc_id,
    parse_status: document.parse_status,
    quality_score: document.quality_score ?? null,
    pages,
    covered_pages: coveredPages,
    page_coverage: pages > 0 ? coveredPages / pages : 0,
    blocks,
    block_types: Object.fromEntries(types.map((row) => [String(row.block_type), Number(row.count)])),
    bbox_blocks: bboxBlocks,
    bbox_coverage: blocks > 0 ? bboxBlocks / blocks : 0,
    text_layer_blocks: Number(count.text_layer_blocks ?? 0),
    ocr_blocks: Number(count.ocr_blocks ?? 0),
    tables: Number(tables[0]?.count ?? 0),
    warnings: latestJob?.warnings ?? [],
  });
}