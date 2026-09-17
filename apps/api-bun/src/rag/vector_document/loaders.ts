// 移植自 apps/api-rs/src/rag/vector_document.rs —— 文档 / chunk / 既有 embedding 的 SQL 加载
import type { Sql } from 'postgres';
import type { CharRange, NormalizedBBox } from '../../models/source_anchor.ts';

export interface DocumentScope {
  tenantId: string;
  kbId: string;
  title: string;
  fileType: string;
  latestParseJobId: string | null;
  parseStatus: string;
}

export interface StoredChunk {
  chunkId: string;
  chunkIndex: number;
  sourceType: string;
  content: string;
  headingPath: string[];
  pageRange: number[];
  tokenCount: number;
  blockIds: string[];
  tableIds: string[];
  anchorIds: string[];
  primaryAnchorId: string | null;
  anchorQuality: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  anchorFormat: string | null;
  anchorKind: string | null;
  anchorPage: number | null;
  anchorSlide: number | null;
  anchorCharRange: CharRange | null;
  anchorBBox: NormalizedBBox | null;
  anchorText: string | null;
}

export interface StoredEmbedding {
  vector: number[];
  contentHash: string;
  embeddedAt: Date;
}

export interface StoredEmbeddings {
  byChunk: Map<string, StoredEmbedding>;
  byHash: Map<string, StoredEmbedding>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('unexpected non-string column in document row');
  return value;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number {
  if (typeof value !== 'number') throw new Error('unexpected non-numeric column in document row');
  return value;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('unexpected non-array column in document row');
  return value.map(asString);
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error('unexpected non-array column in document row');
  return value.map(asNumber);
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') return new Date(value);
  throw new Error('unexpected non-timestamp column in document row');
}

/** 对应 Rust json_column：列缺失或结构不符时返回 null（Rust 侧显式 .ok()）。 */
function jsonColumn<T>(row: Record<string, unknown>, name: string, parse: (record: Record<string, unknown>) => T | null): T | null {
  try {
    const record = asRecord(row[name]);
    if (record === null) return null;
    return parse(record);
  } catch {
    return null;
  }
}

function parseCharRange(record: Record<string, unknown>): CharRange | null {
  const start = record.start;
  const end = record.end;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  return { start, end };
}

function parseNormalizedBBox(record: Record<string, unknown>): NormalizedBBox | null {
  const { x0, y0, x1, y1 } = record;
  if (typeof x0 !== 'number' || typeof y0 !== 'number' || typeof x1 !== 'number' || typeof y1 !== 'number') {
    return null;
  }
  const unit = typeof record.unit === 'string' ? record.unit : 'normalized';
  const rotation = typeof record.rotation === 'number' ? record.rotation : 0;
  return { x0, y0, x1, y1, unit, rotation };
}

export async function loadDocument(sql: Sql, docId: string): Promise<DocumentScope> {
  const rows = await sql.unsafe(
    `SELECT tenant_id, kb_id, title, file_type, latest_parse_job_id, parse_status
     FROM documents WHERE id = \$1`,
    [docId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) throw new Error('failed to load document for vector indexing');
  return {
    tenantId: asString(row.tenant_id),
    kbId: asString(row.kb_id),
    title: asString(row.title),
    fileType: asString(row.file_type),
    latestParseJobId: asNullableString(row.latest_parse_job_id),
    parseStatus: asString(row.parse_status),
  };
}

export async function loadChunks(
  sql: Sql,
  docId: string,
  parseJobId: string,
): Promise<StoredChunk[]> {
  const rows = await sql.unsafe(
    `SELECT c.id, c.chunk_index, c.source_type, c.content, c.heading_path,
            c.page_range, c.token_count, c.block_ids, c.table_ids, c.anchor_ids,
            c.primary_anchor_id, c.anchor_quality, c.metadata, c.created_at,
            a.format, a.kind, a.page, a.slide, a.char_range, a.bbox, a.text AS anchor_text
     FROM chunks c
     LEFT JOIN document_source_anchors a ON a.id = c.primary_anchor_id
     WHERE c.doc_id = \$1 AND c.parse_job_id = \$2
     ORDER BY c.chunk_index`,
    [docId, parseJobId],
  );
  return rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      chunkId: asString(row.id),
      chunkIndex: asNumber(row.chunk_index),
      sourceType: asString(row.source_type),
      content: asString(row.content),
      headingPath: asStringArray(row.heading_path),
      pageRange: asNumberArray(row.page_range),
      tokenCount: asNumber(row.token_count),
      blockIds: asStringArray(row.block_ids),
      tableIds: asStringArray(row.table_ids),
      anchorIds: asStringArray(row.anchor_ids),
      primaryAnchorId: asNullableString(row.primary_anchor_id),
      anchorQuality: asString(row.anchor_quality),
      metadata: asRecord(row.metadata) ?? {},
      createdAt: asDate(row.created_at),
      anchorFormat: asNullableString(row.format),
      anchorKind: asNullableString(row.kind),
      anchorPage: asNullableNumber(row.page),
      anchorSlide: asNullableNumber(row.slide),
      anchorCharRange: jsonColumn(row, 'char_range', parseCharRange),
      anchorBBox: jsonColumn(row, 'bbox', parseNormalizedBBox),
      anchorText: asNullableString(row.anchor_text),
    } satisfies StoredChunk;
  });
}

export async function loadEmbeddings(
  sql: Sql,
  docId: string,
  model: string,
  dimension: number,
): Promise<StoredEmbeddings> {
  const rows = await sql.unsafe(
    `SELECT e.chunk_id, e.embedding_values, e.content_hash, e.embedded_at
     FROM chunk_embeddings e
     JOIN chunks c ON c.id = e.chunk_id
     WHERE c.doc_id = \$1 AND e.embedding_model = \$2
       AND e.status = 'completed' AND e.embedding_dim = \$3
       AND e.embedding_values IS NOT NULL`,
    [docId, model, dimension],
  );
  const embeddings: StoredEmbeddings = { byChunk: new Map(), byHash: new Map() };
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const values = Array.isArray(row.embedding_values)
      ? (row.embedding_values as unknown[]).map(asNumber)
      : [];
    if (values.length !== dimension || values.some((value) => !Number.isFinite(value))) {
      continue;
    }
    const rawEmbeddedAt = row.embedded_at;
    const embedding: StoredEmbedding = {
      vector: values,
      contentHash: asString(row.content_hash),
      embeddedAt: rawEmbeddedAt === null || rawEmbeddedAt === undefined ? new Date() : asDate(rawEmbeddedAt),
    };
    if (!embeddings.byHash.has(embedding.contentHash)) {
      embeddings.byHash.set(embedding.contentHash, embedding);
    }
    embeddings.byChunk.set(asString(row.chunk_id), embedding);
  }
  return embeddings;
}
