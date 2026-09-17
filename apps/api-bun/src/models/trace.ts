// 移植自 apps/api-rs/src/models/trace.rs
export interface QueryTrace {
  id: string; message_id: string; original_query: string; rewritten_query: string | null;
  keywords: string[]; hypothetical_answer: string | null; resolved_refs: ResolvedRef[];
  effective_kb_ids: string[]; rewrite_model: string; created_at: string;
}
export interface ResolvedRef {
  text: string; resolved_to: string;
  source_message_id?: string | null; evidence_message_id?: string | null;
}

export type RetrievalSource = 'dense' | 'bm25' | 'rrf' | 'rerank';

export interface RetrievalTrace {
  id: string; message_id: string; chunk_id: string; doc_id: string; source: RetrievalSource;
  rank: number; score: number; heading_path: string[]; page_range: number[];
  content_preview: string;
}

export type PlanMode = 'single_query' | 'multi_query';
export interface SubQuery { query: string; reason: string; }
export interface RetrievalPlan { mode: PlanMode; queries: SubQuery[]; }
export function defaultRetrievalPlan(): RetrievalPlan { return { mode: 'single_query', queries: [] }; }
