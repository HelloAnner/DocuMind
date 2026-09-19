// 移植自 apps/api-rs/src/api/documents.rs —— 文档详情读取（summary / parse job / blocks / chunks / 预览渲染）
import type { Sql } from 'postgres';
import { AppError } from '../errors.ts';
import { toRfc3339 } from '../infra/time.ts';
import type {
  BlockSummary, ChunkSummary, CleanedBlockSummary, DocumentPreview, DocumentSummary,
  ParseJobSummary, TableSummary,
} from './documents_types.ts';
import { appendPreviewText } from './documents_support.ts';

export async function fetchDocumentSummary(
  sql: Sql, tenantId: string, docId: string,
): Promise<DocumentSummary> {
  const rows = await sql.unsafe(
    `SELECT d.id AS doc_id, d.kb_id, kb.name AS kb_name, d.title,
            COALESCE(d.metadata->>'original_filename', d.storage_key) AS file_name,
            d.file_type,
            'application/octet-stream' AS mime_type,
            d.file_size_bytes AS file_size,
            COALESCE(d.file_sha256, '') AS file_sha256,
            d.parse_status, d.parse_version,
            d.latest_parse_job_id, j.quality_score, d.chunk_count,
            COALESCE((j.parser_config->>'table_count')::int, 0) AS table_count,
            COALESCE((j.parser_config->>'page_count')::int, NULL)::int AS page_count,
            d.created_at AS uploaded_at, d.updated_at
     FROM documents d
     JOIN knowledge_base kb ON kb.id = d.kb_id
     LEFT JOIN document_parse_jobs j ON j.parse_job_id = d.latest_parse_job_id
     WHERE d.tenant_id = \$1 AND d.id = \$2`,
    [tenantId, docId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw AppError.notFound('DOCUMENT_NOT_FOUND', '文档不存在或无权限');
  }
  return documentSummaryFromRow(row);
}

export function documentSummaryFromRow(row: Record<string, unknown>): DocumentSummary {
  return {
    doc_id: String(row.doc_id),
    kb_id: String(row.kb_id),
    kb_name: String(row.kb_name),
    title: String(row.title),
    file_name: String(row.file_name),
    file_type: String(row.file_type),
    mime_type: String(row.mime_type),
    file_size: Number(row.file_size),
    file_sha256: String(row.file_sha256),
    parse_status: String(row.parse_status),
    parse_version: Number(row.parse_version),
    latest_parse_job_id: row.latest_parse_job_id == null ? null : String(row.latest_parse_job_id),
    quality_score: row.quality_score == null ? null : Number(row.quality_score),
    chunk_count: Number(row.chunk_count),
    table_count: Number(row.table_count ?? 0),
    page_count: row.page_count == null ? null : Number(row.page_count),
    uploaded_at: toRfc3339(new Date(row.uploaded_at as string | Date)),
    updated_at: toRfc3339(new Date(row.updated_at as string | Date)),
  };
}

export async function fetchParseJob(sql: Sql, parseJobId: string): Promise<ParseJobSummary | null> {
  const rows = await sql.unsafe(
    `SELECT parse_job_id, status, parser_version, quality_score,
            (parser_config->>'page_count')::int AS page_count,
            (parser_config->>'block_count')::int AS block_count,
            (parser_config->>'table_count')::int AS table_count,
            (parser_config->>'char_count')::int AS char_count,
            COALESCE(parser_config->'warnings', '[]'::jsonb) AS warnings,
            error_code, error_message, started_at,
            completed_at AS finished_at, created_at
     FROM document_parse_jobs
     WHERE parse_job_id = \$1`,
    [parseJobId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    parse_job_id: String(row.parse_job_id),
    status: String(row.status),
    parser_version: String(row.parser_version),
    quality_score: row.quality_score == null ? null : Number(row.quality_score),
    page_count: row.page_count == null ? null : Number(row.page_count),
    block_count: row.block_count == null ? null : Number(row.block_count),
    table_count: row.table_count == null ? null : Number(row.table_count),
    char_count: row.char_count == null ? null : Number(row.char_count),
    warnings: row.warnings ?? [],
    error_code: row.error_code == null ? null : String(row.error_code),
    error_message: row.error_message == null ? null : String(row.error_message),
    started_at: row.started_at == null ? null : toRfc3339(new Date(row.started_at as string | Date)),
    finished_at: row.finished_at == null ? null : toRfc3339(new Date(row.finished_at as string | Date)),
    created_at: toRfc3339(new Date(row.created_at as string | Date)),
  };
}

export async function fetchBlocks(
  sql: Sql, docId: string, parseJobId: string | null,
): Promise<BlockSummary[]> {
  if (parseJobId === null) return [];
  const rows = await sql.unsafe(
    `SELECT id AS block_id, block_index, block_type, content AS text,
            heading_path,
            (metadata->>'heading_level')::int AS heading_level,
            page_range,
            (metadata->>'slide')::int AS slide_index,
            (metadata->>'table_id')::uuid AS table_id,
            metadata->'bbox' AS bbox,
            metadata->'metadata' AS block_metadata
     FROM document_blocks
     WHERE doc_id = \$1 AND parse_job_id = \$2
     ORDER BY block_index
     LIMIT 300`,
    [docId, parseJobId],
  );
  return rows.map((row) => {
    const pageRange = (row.page_range as number[] | null) ?? [];
    return {
      block_id: String(row.block_id),
      block_index: Number(row.block_index),
      block_type: String(row.block_type),
      text: String(row.text),
      heading_level: row.heading_level == null ? null : Number(row.heading_level),
      heading_path: (row.heading_path as string[] | null) ?? [],
      page_start: pageRange.length > 0 ? pageRange[0]! : null,
      page_end: pageRange.length > 0 ? pageRange[pageRange.length - 1]! : null,
      slide_index: row.slide_index == null ? null : Number(row.slide_index),
      table_id: row.table_id == null ? null : String(row.table_id),
      bbox: row.bbox ?? null,
      metadata: row.block_metadata ?? {},
    };
  });
}

export async function fetchChunks(
  sql: Sql, docId: string, parseJobId: string | null,
): Promise<ChunkSummary[]> {
  if (parseJobId === null) return [];
  const rows = await sql.unsafe(
    `SELECT id AS chunk_id, chunk_index,
            COALESCE(source_type, metadata->>'source_type', 'paragraph') AS source_type,
            content, heading_path, page_range, token_count, metadata
     FROM chunks
     WHERE doc_id = \$1 AND parse_job_id = \$2
     ORDER BY chunk_index
     LIMIT 200`,
    [docId, parseJobId],
  );
  return rows.map((row) => {
    const pageRange = (row.page_range as number[] | null) ?? [];
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const rawSlide = metadata['slide'];
    const slide = typeof rawSlide === 'number' && Number.isInteger(rawSlide) ? rawSlide : null;
    return {
      chunk_id: String(row.chunk_id),
      chunk_index: Number(row.chunk_index),
      source_type: String(row.source_type),
      content: String(row.content),
      heading_path: (row.heading_path as string[] | null) ?? [],
      page_start: pageRange.length > 0 ? pageRange[0]! : null,
      page_end: pageRange.length > 0 ? pageRange[pageRange.length - 1]! : null,
      slide_start: slide,
      slide_end: slide,
      token_count: Number(row.token_count),
    };
  });
}

export async function fetchCleanedBlocks(
  sql: Sql, docId: string, parseJobId: string | null,
): Promise<CleanedBlockSummary[]> {
  if (parseJobId === null) return [];
  const rows = await sql.unsafe(
    `SELECT block_id, block_index, block_type, cleaned_text, is_removed,
            remove_reason, cleaning_ops, heading_path
     FROM cleaned_blocks
     WHERE doc_id = \$1 AND parse_job_id = \$2
     ORDER BY block_index
     LIMIT 300`,
    [docId, parseJobId],
  );
  return rows.map((row) => ({
    block_id: String(row.block_id),
    block_index: Number(row.block_index),
    block_type: String(row.block_type),
    cleaned_text: String(row.cleaned_text),
    is_removed: Boolean(row.is_removed),
    remove_reason: row.remove_reason == null ? null : String(row.remove_reason),
    cleaning_ops: (row.cleaning_ops as string[] | null) ?? [],
    heading_path: (row.heading_path as string[] | null) ?? [],
  }));
}

export async function fetchTables(
  sql: Sql, docId: string, parseJobId: string | null,
): Promise<TableSummary[]> {
  if (parseJobId === null) return [];
  const rows = await sql.unsafe(
    `SELECT id AS table_id, table_index,
            COALESCE(metadata->>'title', '') AS title,
            markdown, cells, metadata
     FROM document_tables
     WHERE doc_id = \$1 AND parse_job_id = \$2
     ORDER BY table_index
     LIMIT 100`,
    [docId, parseJobId],
  );
  return rows.map((row) => {
    const cells = row.cells;
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const cellRows = Array.isArray(cells) ? cells : [];
    const rawRowCount = metadata['row_count'];
    const rawColCount = metadata['col_count'];
    const rowCount = typeof rawRowCount === 'number' && Number.isInteger(rawRowCount)
      ? rawRowCount : cellRows.length;
    const firstRow = cellRows.length > 0 && Array.isArray(cellRows[0]) ? cellRows[0] as unknown[] : [];
    const colCount = typeof rawColCount === 'number' && Number.isInteger(rawColCount)
      ? rawColCount : firstRow.length;
    const title = String(row.title);
    return {
      table_id: String(row.table_id),
      table_index: Number(row.table_index),
      title: title === '' ? null : title,
      row_count: rowCount,
      col_count: colCount,
      headers: metadata['headers'] ?? [],
      markdown: String(row.markdown),
      quality: metadata['quality'] ?? {},
    };
  });
}

export function renderDocumentPreview(
  document: DocumentSummary, latestJob: ParseJobSummary | null, blocks: BlockSummary[],
): DocumentPreview {
  const charCount = latestJob?.char_count
    ?? blocks.reduce((sum, block) => sum + Array.from(block.text).length, 0);

  if (blocks.length === 0) {
    const mode = document.parse_status === 'parse_failed' ? 'failed' : 'pending';
    return {
      mode, title: document.title, text: '', truncated: false,
      source: 'document_blocks', char_count: charCount,
    };
  }

  const target = { text: '', written: 0 };
  let truncated = false;
  for (const block of blocks) {
    const rendered = renderPreviewBlock(block);
    if (rendered.trim() === '') continue;
    if (!appendPreviewText(target, rendered)) { truncated = true; break; }
    if (!appendPreviewText(target, '\n\n')) { truncated = true; break; }
  }

  return {
    mode: 'parsed_text',
    title: document.title,
    text: target.text.replace(/\s+$/, ''),
    truncated,
    source: 'document_blocks',
    char_count: charCount,
  };
}

export function renderPreviewBlock(block: BlockSummary): string {
  const text = block.text.trim();
  if (text === '') return '';
  if (block.heading_level !== null) {
    const level = Math.min(6, Math.max(1, block.heading_level));
    return `${'#'.repeat(level)} ${text}`;
  }
  if (block.block_type === 'table') {
    const heading = block.heading_path.length > 0
      ? block.heading_path[block.heading_path.length - 1]! : '表格';
    return `[表格: ${heading}]\n${text}`;
  }
  return text;
}
