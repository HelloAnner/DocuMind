// 移植自 apps/api-rs/src/api/documents.rs —— DTO / 内部记录类型
// 硬性约定：对外 JSON key 与 Rust serde 输出逐字一致（snake_case，无 camelCase 重命名）。
import type { EmbeddingConfig } from '../config.ts';
import type { ParsedBundle } from '../document/types.ts';

/** Rust: PREVIEW_CHAR_LIMIT */
export const PREVIEW_CHAR_LIMIT = 60_000;
/** Rust: MAX_UPLOAD_BYTES */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Rust: OFFICE_CONVERSION_TIMEOUT_SECONDS */
export const OFFICE_CONVERSION_TIMEOUT_SECONDS = 90;
/** Rust: OCR_RENDER_DPI */
export const OCR_RENDER_DPI = 220;
/** ponytail: PDF.js can exceed 300 MB per complex PDF; serialize parsing until it moves out of process. */
export const PARSE_WORKER_CONCURRENCY = 1;

// ---------------------------------------------------------------------------
// Cloud-side response / request types
// ---------------------------------------------------------------------------

export interface UploadDocumentResponse {
  document_id: string;
  parse_job_id: string;
  title: string;
  file_type: string;
  parse_status: string;
  block_count: number;
  table_count: number;
  chunk_count: number;
  storage_key: string;
}

export interface DeleteDocumentResponse {
  document_id: string;
  status: string;
}

export interface ExcludeFromSearchResponse {
  document_id: string;
  status: string;
  es_deleted_chunks: number;
}

export interface ReplaceDocumentFileResponse {
  document_id: string;
  parse_job_id: string;
  parse_status: string;
  parse_version: number;
  title: string;
  file_type: string;
  file_sha256: string;
  storage_key: string;
}

export interface SendToOcrResponse {
  document_id: string;
  ocr_job_id: string;
  parse_status: string;
  ocr_status: string;
}

export interface ReprocessDocumentResponse {
  document_id: string;
  parse_job_id: string;
  parse_status: string;
  parse_version: number;
  block_count: number;
  table_count: number;
  chunk_count: number;
  reused_existing_parse: boolean;
}

// ---------------------------------------------------------------------------
// Local-only response / request types
// ---------------------------------------------------------------------------

export interface DocumentListQuery {
  kb_id: string | null;
  status: string | null;
  q: string | null;
  page: number;
  page_size: number;
}

export interface MoveDocumentRequest {
  kb_id: string;
}

export interface RetryDocumentsRequest {
  doc_ids: string[];
}

export interface DocumentSummary {
  doc_id: string;
  kb_id: string;
  kb_name: string;
  title: string;
  file_name: string;
  file_type: string;
  mime_type: string;
  file_size: number;
  file_sha256: string;
  parse_status: string;
  parse_version: number;
  latest_parse_job_id: string | null;
  quality_score: number | null;
  chunk_count: number;
  table_count: number;
  page_count: number | null;
  uploaded_at: string;
  updated_at: string;
}

export interface DocumentDetail {
  document: DocumentSummary;
  latest_job: ParseJobSummary | null;
  preview: DocumentPreview;
  blocks: BlockSummary[];
  cleaned_blocks: CleanedBlockSummary[];
  chunks: ChunkSummary[];
  tables: TableSummary[];
}

export interface DocumentPreview {
  mode: string;
  title: string;
  text: string;
  truncated: boolean;
  source: string;
  char_count: number;
}

export interface FilePreviewResponse {
  doc_id: string;
  parse_job_id: string | null;
  file_name: string;
  format: string;
  preview_type: string;
  preview_url: string;
  manifest_url: string;
  source_status: string;
}

export interface FilePreviewUrlResponse {
  doc_id: string;
  parse_job_id: string | null;
  file_name: string;
  format: string;
  preview_type: string;
  expires_at: string;
  expires_in_seconds: number;
  preview_url: string;
  manifest_url: string;
}

export interface FilePreviewAccessClaims {
  sub: string;
  tenant_id: string;
  doc_id: string;
  scope: string;
  exp: number;
}

export interface PreviewAccessQuery {
  preview_token: string | null;
  conversation_id: string | null;
}

export interface FilePreviewManifest {
  doc_id: string;
  parse_job_id: string | null;
  file_name: string;
  format: string;
  preview_type: string;
  page_count: number | null;
  pages: FilePreviewManifestPage[];
  text_layer_available: boolean;
  conversion_status: string;
}

export interface FilePreviewManifestPage {
  page: number;
  width: number;
  height: number;
  rotation: number;
  text_layer_available: boolean;
}

export interface ParseJobSummary {
  parse_job_id: string;
  status: string;
  parser_version: string;
  quality_score: number | null;
  page_count: number | null;
  block_count: number | null;
  table_count: number | null;
  char_count: number | null;
  warnings: unknown;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface BlockSummary {
  block_id: string;
  block_index: number;
  block_type: string;
  text: string;
  heading_level: number | null;
  heading_path: string[];
  page_start: number | null;
  page_end: number | null;
  slide_index: number | null;
  table_id: string | null;
  bbox: unknown;
  metadata: unknown;
}

export interface CleanedBlockSummary {
  block_id: string;
  block_index: number;
  block_type: string;
  cleaned_text: string;
  is_removed: boolean;
  remove_reason: string | null;
  cleaning_ops: string[];
  heading_path: string[];
}

export interface ChunkSummary {
  chunk_id: string;
  chunk_index: number;
  source_type: string;
  content: string;
  heading_path: string[];
  page_start: number | null;
  page_end: number | null;
  slide_start: number | null;
  slide_end: number | null;
  token_count: number;
}

export interface TableSummary {
  table_id: string;
  table_index: number;
  title: string | null;
  row_count: number;
  col_count: number;
  headers: unknown;
  markdown: string;
  quality: unknown;
}

// ---------------------------------------------------------------------------
// 内部记录
// ---------------------------------------------------------------------------

export interface UploadedFile {
  title: string;
  file_name: string;
  mime_type: string;
  upload_batch_id: string | null;
  bytes: Uint8Array;
}

export interface ParseArtifacts {
  bundle: ParsedBundle;
  parser_config: Record<string, unknown>;
  parse_identity: string;
  quality_score: number;
  parse_status: string;
}

export interface DocumentRecord {
  id: string;
  tenant_id: string;
  kb_id: string;
  title: string;
  file_type: string;
  file_name: string;
  mime_type: string;
  storage_key: string;
  file_sha256: string;
  parse_version: number;
  parse_status: string;
  latest_parse_job_id: string | null;
  chunk_count: number;
}

export interface ParseWriteScope {
  tenant_id: string;
  kb_id: string;
  doc_id: string;
  parse_job_id: string;
  parse_version: number;
}

export interface ParseJobTask {
  tenant_id: string;
  kb_id: string;
  doc_id: string;
  parse_job_id: string;
  parse_version: number;
  title: string;
  file_name: string;
  mime_type: string;
  file_type: string;
  parser_config: Record<string, unknown>;
  parse_identity: string;
  bytes: Uint8Array;
  embedding_config: EmbeddingConfig;
  force_index: boolean;
}
