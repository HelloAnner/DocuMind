// 移植自 apps/api-rs/src/document/mod.rs —— 行为对齐 Rust 原版，错误信息保持一致

// document 模块公共类型与常量（JSON key 与 serde 输出一致，snake_case）

import type { SourceAnchor } from '../models/source_anchor.ts';
import type { CleanStats, CleanedBlock } from './cleaning.ts';

export const PARSER_VERSION = 'documind-parser@0.6.0';
export const SCHEMA_VERSION = 'parsed-document-v1';
export const MAX_OFFICE_ZIP_ENTRIES = 10_000;
export const MAX_OFFICE_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
export const MAX_OFFICE_ENTRY_BYTES = 100 * 1024 * 1024;
export const MAX_OFFICE_XML_BYTES = 64 * 1024 * 1024;
export const MAX_OFFICE_COMPRESSION_RATIO = 200;
export const MAX_OFFICE_XML_DEPTH = 256;
export const MAX_PDF_PAGES = 1_000;
export const MAX_PDF_PAGE_TEXT_CHARS = 50_000;

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** FileType 对应 Rust enum；值为 as_str()（Markdown -> "md", Text -> "txt"） */
export type FileType = 'pdf' | 'docx' | 'pptx' | 'md' | 'txt';

export interface ParsedDocument {
  doc_id: string;
  parse_job_id: string;
  file_type: string;
  title: string;
  pages: number | null;
  blocks: ParsedBlock[];
  tables: ParsedTable[];
  anchors: SourceAnchor[];
  warnings: string[];
  quality_score: number;
}

export interface ParsedBlock {
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
  bbox: unknown | null;
  anchor_ids: string[];
  source_ref: unknown;
  metadata: unknown;
}

export interface ParsedTableCell {
  cell_id: string;
  row_index: number;
  col_index: number;
  rowspan: number;
  colspan: number;
  text: string;
  normalized_text: string;
  is_header: boolean;
  data_type: string;
  bbox: unknown | null;
  style: unknown;
  source_ref: unknown;
}

export interface ParsedTable {
  table_id: string;
  block_id: string;
  table_index: number;
  title: string | null;
  heading_path: string[];
  page_start: number | null;
  page_end: number | null;
  slide_index: number | null;
  headers: string[];
  rows: string[][];
  cells: ParsedTableCell[];
  markdown: string;
  quality: unknown;
  source_ref: unknown;
}

export interface ChunkDraft {
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
  block_ids: string[];
  table_ids: string[];
  anchor_ids: string[];
  primary_anchor_id: string | null;
  anchor_quality: string;
  metadata: Record<string, unknown>;
}

export interface ParsedBundle {
  file_type: FileType;
  file_sha256: string;
  parsed: ParsedDocument;
  cleaned_blocks: CleanedBlock[];
  clean_stats: CleanStats;
  chunks: ChunkDraft[];
}
