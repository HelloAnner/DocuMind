// 移植自 apps/api-rs/src/api/documents.rs —— 纯函数助手（不含 IO）
import type { Context } from 'hono';
import { AppError } from '../errors.ts';
import { loadChunkingConfig } from '../config.ts';
import type { AppEnv } from '../http/types.ts';
import { PARSER_VERSION } from '../document/types.ts';
import { CLEANER_VERSION } from '../document/cleaning.ts';
import type { ParsedBundle } from '../document/types.ts';
import { MAX_OFFICE_ZIP_ENTRIES, MAX_OFFICE_UNCOMPRESSED_BYTES, MAX_OFFICE_ENTRY_BYTES,
  MAX_OFFICE_XML_BYTES, MAX_OFFICE_COMPRESSION_RATIO, MAX_PDF_PAGES, MAX_PDF_PAGE_TEXT_CHARS,
} from '../document/types.ts';
import { PREVIEW_CHAR_LIMIT } from './documents_types.ts';
import type { DocumentRecord, ParseJobTask } from './documents_types.ts';

// ---------------------------------------------------------------------------
// HTTP 助手
// ---------------------------------------------------------------------------

/** 取路径参数；Hono 未标注路由字面量时可能返回 undefined（Rust 由 axum 保证存在） */
export function pathParam(c: Context<AppEnv>, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value === '') {
    throw AppError.badRequest('BAD_REQUEST', `缺少路径参数 ${name}`);
  }
  return value;
}

/** Rust: ingest::CHUNKER_VERSION（document/chunking.rs 尚未移植，常量值与 Rust 对齐） */
export const CHUNKER_VERSION = 'documind-chunker@0.3.0';

// ---------------------------------------------------------------------------
// 状态判定（与 Rust matches! 列表逐字一致）
// ---------------------------------------------------------------------------

export function canExcludeFromSearch(parseStatus: string): boolean {
  return ['indexed', 'parse_low_confidence', 'parse_failed', 'embedding_failed'].includes(parseStatus);
}

export function canReplaceFile(parseStatus: string): boolean {
  return ['indexed', 'parse_low_confidence', 'parse_failed', 'embedding_failed', 'excluded_from_search']
    .includes(parseStatus);
}

export function canSendToOcr(parseStatus: string): boolean {
  return parseStatus === 'parse_low_confidence';
}

export function canMoveDocument(parseStatus: string): boolean {
  return ['parsed', 'cleaned', 'indexed', 'parse_low_confidence', 'parse_failed', 'embedding_failed',
    'excluded_from_search'].includes(parseStatus);
}

export function isOfficePreviewType(fileType: string): boolean {
  return fileType === 'docx' || fileType === 'pptx';
}

export function previewTypeFor(fileType: string): string {
  switch (fileType) {
    case 'pdf': return 'pdf';
    case 'txt':
    case 'md': return 'text';
    case 'pptx':
    case 'docx': return 'office_pdf';
    default: return 'original';
  }
}

export function sourceStatusFor(parseStatus: string): string {
  switch (parseStatus) {
    case 'parse_failed':
    case 'embedding_failed': return 'degraded';
    case 'parse_low_confidence':
    case 'ocr_pending': return 'low_confidence';
    default: return 'available';
  }
}

export function mimeTypeForDocument(doc: DocumentRecord): string {
  switch (doc.file_type) {
    case 'pdf': return 'application/pdf';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'md': return 'text/markdown; charset=utf-8';
    case 'txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

// ---------------------------------------------------------------------------
// 解析产物判定
// ---------------------------------------------------------------------------

export function isScannedPdfNoTextLayer(bundle: ParsedBundle): boolean {
  return bundle.file_type === 'pdf' && bundle.parsed.warnings.includes('scanned_pdf_no_text_layer');
}

export function isOcrParserConfig(parserConfig: Record<string, unknown>): boolean {
  return parserConfig['job_kind'] === 'ocr';
}

export function isOcrTask(task: ParseJobTask): boolean {
  return isOcrParserConfig(task.parser_config);
}

export function parseStatusForQuality(score: number): string {
  if (score >= 0.75) return 'chunked';
  if (score >= 0.55) return 'parse_low_confidence';
  throw AppError.badRequest('PARSE_QUALITY_TOO_LOW', '文档解析质量过低，未进入索引');
}

export function parseStatusForResult(
  qualityScore: number, scannedPdfNoTextLayer: boolean, ocrTask: boolean,
): string {
  if (scannedPdfNoTextLayer && !ocrTask) return 'parse_low_confidence';
  return parseStatusForQuality(qualityScore);
}

/** Rust: app_error_details —— Internal 统一映射为 PARSE_INTERNAL_ERROR */
export function appErrorDetails(err: AppError): [string, string] {
  if (err.kind === 'internal') return ['PARSE_INTERNAL_ERROR', err.message];
  return [err.code, err.message];
}

// ---------------------------------------------------------------------------
// 杂项助手
// ---------------------------------------------------------------------------

export function sha256Hex(bytes: Uint8Array | string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
  return hasher.digest('hex');
}

/** 收敛为 postgres.js 可接受的 JSON 参数（等价于 serde_json::Value） */
export function toJson(value: unknown): import('postgres').JSONValue {
  return JSON.parse(JSON.stringify(value ?? null)) as import('postgres').JSONValue;
}

/** 对应 serde_json::Value 的 Display：对象 key 按字典序（serde_json 默认 BTreeMap） */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
}

export function documentStorageKey(
  tenantId: string, kbId: string, docId: string, fileSha256: string, fileType: string,
): string {
  return `tenants/${tenantId}/knowledge-bases/${kbId}/documents/${docId}/original/${fileSha256}.${fileType}`;
}

export function parseIdentityFor(fileSha256: string, parserConfig: Record<string, unknown>): string {
  return sha256Hex(`${fileSha256}:${PARSER_VERSION}:${canonicalJson(parserConfig)}`);
}

export function currentParserConfig(): Record<string, unknown> {
  // 切片参数统一经 config.ts 读取（RAG_* 环境变量，与 Rust ChunkConfig::default 对齐）
  const chunking = loadChunkingConfig();
  return {
    parser_version: PARSER_VERSION,
    cleaner_version: CLEANER_VERSION,
    chunker_version: CHUNKER_VERSION,
    max_office_zip_entries: MAX_OFFICE_ZIP_ENTRIES,
    max_office_uncompressed_bytes: MAX_OFFICE_UNCOMPRESSED_BYTES,
    max_office_entry_bytes: MAX_OFFICE_ENTRY_BYTES,
    max_office_xml_bytes: MAX_OFFICE_XML_BYTES,
    max_office_compression_ratio: MAX_OFFICE_COMPRESSION_RATIO,
    max_pdf_pages: MAX_PDF_PAGES,
    max_pdf_page_text_chars: MAX_PDF_PAGE_TEXT_CHARS,
    target_chunk_tokens: chunking.targetChunkTokens,
    max_chunk_tokens: chunking.maxChunkTokens,
    hard_split_tokens: chunking.hardSplitTokens,
    min_chunk_tokens: chunking.minChunkTokens,
    chunk_overlap_tokens: chunking.overlapTokens,
    max_table_rows_per_chunk: chunking.maxTableRowsPerChunk,
    max_table_token_per_chunk: chunking.maxTableTokenPerChunk,
  };
}

export function pageRange(start: number | null, end: number | null): number[] {
  if (start !== null && end !== null && end >= start) {
    const out: number[] = [];
    for (let page = start; page <= end; page += 1) out.push(page);
    return out;
  }
  if (start !== null) return [start];
  if (end !== null) return [end];
  return [];
}

export function uuidListFromMetadata(metadata: unknown, key: string): string[] {
  if (typeof metadata !== 'object' || metadata === null) return [];
  const raw = (metadata as Record<string, unknown>)[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string')
    .filter((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
}

export function sanitizeFileName(value: string): string {
  const cleaned = Array.from(value)
    .filter((ch) => ch !== '/' && ch !== '\\' && ch !== '\u0000' && !/\p{Cc}/u.test(ch))
    .join('')
    .trim();
  return cleaned.length === 0 ? 'document.bin' : cleaned;
}

/** Rust: Path::file_stem —— 失败时返回 null（调用方决定默认值） */
function rustFileStem(fileName: string): string | null {
  let trimmed = fileName;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  const component = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  if (component === '' || component === '.' || component === '..') return null;
  const dot = component.lastIndexOf('.');
  if (dot > 0 && !(dot === component.length - 1 && component === '..')) return component.slice(0, dot);
  return component;
}

export function titleFromFileName(fileName: string): string {
  const stem = rustFileStem(fileName);
  if (stem === null) return '未命名文档';
  const trimmed = stem.trim();
  return trimmed.length === 0 ? '未命名文档' : trimmed;
}

/** Rust: parse_byte_range —— 返回 [start, end) 半开区间 */
export function parseByteRange(range: string, totalSize: number): [number, number] | null {
  if (!range.startsWith('bytes=') || totalSize <= 0) return null;
  const body = range.slice('bytes='.length);
  if (body.includes(',')) return null;
  const dash = body.indexOf('-');
  if (dash < 0) return null;
  const startStr = body.slice(0, dash);
  const endStr = body.slice(dash + 1);
  const digits = /^\d+$/;

  if (startStr === '') {
    if (!digits.test(endStr)) return null;
    const suffix = Number(endStr);
    if (suffix <= 0) return null;
    return [Math.max(0, totalSize - suffix), totalSize];
  }

  if (!digits.test(startStr)) return null;
  const start = Number(startStr);
  let end = totalSize;
  if (endStr !== '') {
    if (!digits.test(endStr)) return null;
    end = Math.min(Number(endStr) + 1, totalSize);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end || start >= totalSize) {
    return null;
  }
  return [start, end];
}

export function rangeNotSatisfiable(totalSize: number): Response {
  return new Response(null, {
    status: 416,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${totalSize}`,
    },
  });
}

/** Rust: append_preview_text —— 按字符（Unicode scalar）截断，返回是否完整写入 */
export function appendPreviewText(target: { text: string; written: number }, value: string): boolean {
  if (target.written >= PREVIEW_CHAR_LIMIT) return false;
  const available = PREVIEW_CHAR_LIMIT - target.written;
  const chars = Array.from(value);
  if (chars.length <= available) {
    target.text += value;
    target.written += chars.length;
    return true;
  }
  target.text += chars.slice(0, available).join('');
  target.written = PREVIEW_CHAR_LIMIT;
  return false;
}
