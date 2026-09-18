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