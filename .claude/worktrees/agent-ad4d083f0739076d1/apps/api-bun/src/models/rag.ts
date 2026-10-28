// 移植自 apps/api-rs/src/models/rag.rs
import type { RetrievalSource } from './trace.ts';
import type { SourceAnchor } from './source_anchor.ts';

export interface RetrievedChunk {
  chunk_id: string; doc_id: string; doc_title: string; file_type: string; content: string;
  heading_path: string[]; page_range: number[]; block_ids: string[]; table_ids: string[];
  anchor_ids: string[]; primary_anchor_id: string | null; anchor_quality: string;
  primary_anchor: SourceAnchor | null; anchors: SourceAnchor[]; metadata: Record<string, unknown>;
  score: number; source: RetrievalSource;
}
export interface RerankedChunk { chunk: RetrievedChunk; score: number; rank: number; }
export interface EvidencePack { chunks: RerankedChunk[]; context_text: string; }

export interface RetrievalInput {
  tenant_id: string; effective_kb_ids: string[]; queries: string[];
  hypothetical_answer?: string | null; top_k: number; dense_top_k: number; bm25_top_k: number;
}
export interface RetrievalOutput { chunks: RetrievedChunk[]; warnings?: string[]; }
export interface RerankInput { query: string; chunks: RetrievedChunk[]; top_k: number; }
export interface ContextInput { chunks: RerankedChunk[]; original_query: string; max_context_chars: number; }
