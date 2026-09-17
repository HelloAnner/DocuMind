// 移植自 apps/api-rs/src/rag/retriever.rs —— Elasticsearch _source 解析为 RetrievedChunk
import type { RetrievedChunk } from '../../models/rag.ts';
import type { RetrievalSource } from '../../models/trace.ts';
import type { CharRange, NormalizedBBox, SourceAnchor } from '../../models/source_anchor.ts';
import { isUuid } from '../../infra/uuid.ts';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export function chunkFromEsSource(
  source: Record<string, unknown>,
  score: number,
  retrievalSource: RetrievalSource,
): RetrievedChunk | null {
  const chunkId = uuidValue(source.chunk_id);
  if (chunkId === null) return null;
  const docId = uuidValue(source.doc_id);
  if (docId === null) return null;
  const docTitle =
    stringValue(source.doc_title) ?? stringValue(source.title) ?? '未命名文档';
  const fileType = stringValue(source.file_type) ?? 'unknown';
  const content = stringValue(source.content);
  if (content === null) return null;
  const headingPath = stringVec(source.heading_path);
  const blockIds = uuidVec(source.block_ids);
  const tableIds = uuidVec(source.table_ids);
  const anchorIds = uuidVec(source.anchor_ids);
  const primaryAnchorId = uuidValue(source.primary_anchor_id);
  const anchorQuality = stringValue(source.anchor_quality) ?? 'unknown';
  const metadata = asRecord(source.metadata) ?? {};
  const anchorPage = i32Value(source.anchor_page);
  const pageRange =
    pageRangeFromEs(source.page_range) ??
    (anchorPage !== null ? [anchorPage] : []);
  const primaryAnchor: SourceAnchor | null = primaryAnchorId === null
    ? null
    : {
        anchor_id: primaryAnchorId,
        doc_id: docId,
        parse_job_id: uuidValue(source.parse_job_id) ?? NIL_UUID,
        tenant_id: uuidValue(source.tenant_id) ?? NIL_UUID,
        format: stringValue(source.anchor_format) ?? fileType,
        kind: stringValue(source.anchor_kind) ?? 'paragraph',
        page: anchorPage,
        slide: i32Value(source.anchor_slide),
        block_id: blockIds.length > 0 ? blockIds[0]! : null,
        table_id: tableIds.length > 0 ? tableIds[0]! : null,
        cell_range: null,
        char_range: parseJsonAs(source.anchor_char_range, parseCharRange),
        bbox: parseJsonAs(source.anchor_bbox, parseNormalizedBBox),
        source_ref: source.anchor_source_ref ?? { source: 'elasticsearch' },
        text: stringValue(source.anchor_text) ?? '',
        text_hash: stringValue(source.anchor_text_hash),
        anchor_quality: anchorQuality,
      };

  return {
    chunk_id: chunkId,
    doc_id: docId,
    doc_title: docTitle,
    file_type: fileType,
    content,
    heading_path: headingPath,
    page_range: pageRange,
    block_ids: blockIds,
    table_ids: tableIds,
    anchor_ids: anchorIds,
    primary_anchor_id: primaryAnchorId,
    anchor_quality: anchorQuality,
    primary_anchor: primaryAnchor,
    metadata,
    score,
    source: retrievalSource,
  };
}

export function uuidValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return isUuid(value) ? value : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringVec(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function uuidVec(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    const id = uuidValue(item);
    if (id !== null) ids.push(id);
  }
  return ids;
}

function pageRangeFromEs(value: unknown): number[] | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    const pages = value
      .map((page) => i32Value(page))
      .filter((page): page is number => page !== null);
    return pages.length > 0 ? pages : null;
  }
  const range = asRecord(value);
  if (range === null) return null;
  const start = i32Value(range.gte);
  if (start === null) return null;
  const end = i32Value(range.lte) ?? start;
  const pages: number[] = [];
  for (let page = start; page <= end && pages.length < 20; page++) pages.push(page);
  return pages;
}

function i32Value(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 对应 Rust serde_json::from_value::<T>(value).ok()：结构不符时返回 null。 */
function parseJsonAs<T>(
  value: unknown,
  parse: (record: Record<string, unknown>) => T | null,
): T | null {
  const record = asRecord(value);
  if (record === null) return null;
  return parse(record);
}

function parseCharRange(record: Record<string, unknown>): CharRange | null {
  const start = i32Value(record.start);
  const end = i32Value(record.end);
  if (start === null || end === null) return null;
  return { start, end };
}

function parseNormalizedBBox(record: Record<string, unknown>): NormalizedBBox | null {
  const nums = [record.x0, record.y0, record.x1, record.y1];
  if (nums.some((n) => typeof n !== 'number')) return null;
  const unit = stringValue(record.unit) ?? 'normalized';
  const rotation = i32Value(record.rotation) ?? 0;
  return {
    x0: nums[0] as number,
    y0: nums[1] as number,
    x1: nums[2] as number,
    y1: nums[3] as number,
    unit,
    rotation,
  };
}
