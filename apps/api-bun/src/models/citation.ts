// 移植自 apps/api-rs/src/models/citation.rs
import type { CharRange, NormalizedBBox } from './source_anchor.ts';

export interface CitationAnchor {
  anchor_id: string | null; parse_job_id: string | null;
  format: string; kind: string;
  page: number | null; slide: number | null;
  block_ids: string[]; table_ids: string[];
  char_range: CharRange | null; bbox: NormalizedBBox | null;
  location_status: string;
}
export interface Citation {
  id: string; assistant_message_id: string; index: number; chunk_id: string; doc_id: string;
  doc_title: string; page_range: number[]; heading_path: string[]; quote: string; score: number;
  source_status: string; anchor: CitationAnchor | null;
}
