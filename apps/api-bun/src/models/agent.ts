// 移植自 apps/api-rs/src/models/agent.rs
import type { CitationAnchor } from './citation.ts';
import type { Confidence, Usage } from './index.ts';
import type { ResolvedRef, RetrievalPlan, RetrievalTrace } from './trace.ts';

export type AgentMode =
  | 'answerer' | 'clarifier' | 'summarizer' | 'comparer' | 'analyst' | 'navigator' | 'reviewer';
export const agentModes: AgentMode[] = [
  'answerer', 'clarifier', 'summarizer', 'comparer', 'analyst', 'navigator', 'reviewer',
];
export function isAgentMode(value: string): value is AgentMode {
  return agentModes.includes(value as AgentMode);
}

export interface ConversationTurn {
  user_message: string; assistant_answer: string; citations?: string[];
}

export interface AgentRequest {
  tenant_id: string; user_id: string; conversation_id: string;
  user_message_id: string; assistant_message_id: string;
  original_query: string; effective_kb_ids: string[];
  history: ConversationTurn[]; options: AgentOptions;
}

export interface AgentOptions {
  mode?: AgentMode | null; tone: string; proactive_followup: boolean;
  max_followup_suggestions: number; allow_analyst_mode: boolean; require_citation: boolean;
  generation: GenerationOptions; retrieval: RetrievalRuntimeOptions; runtime: AgentRuntimeOptions;
}
export function defaultAgentOptions(): AgentOptions {
  return {
    mode: null, tone: 'concise_warm', proactive_followup: true, max_followup_suggestions: 2,
    allow_analyst_mode: true, require_citation: true,
    generation: defaultGenerationOptions(),
    retrieval: defaultRetrievalRuntimeOptions(),
    runtime: defaultAgentRuntimeOptions(),
  };
}

export interface AgentRuntimeOptions {
  hyde_enabled: boolean; max_react_steps: number; max_queries_per_step: number;
  max_history_turns: number; max_history_chars: number; max_context_chars: number;
  allow_verifier_correction: boolean;
}
export function defaultAgentRuntimeOptions(): AgentRuntimeOptions {
  return {
    hyde_enabled: true, max_react_steps: 4, max_queries_per_step: 4,
    max_history_turns: 12, max_history_chars: 24_000, max_context_chars: 30_000,
    allow_verifier_correction: true,
  };
}

export interface GenerationOptions { model: string; temperature: number; max_output_tokens: number; }
export function defaultGenerationOptions(): GenerationOptions {
  return { model: 'qwen-turbo', temperature: 0.2, max_output_tokens: 1200 };
}

export interface RetrievalRuntimeOptions {
  dense_top_k: number; bm25_top_k: number; rrf_top_k: number; rerank_top_k: number;
  rerank_enabled: boolean;
}
export function defaultRetrievalRuntimeOptions(): RetrievalRuntimeOptions {
  return { dense_top_k: 100, bm25_top_k: 100, rrf_top_k: 20, rerank_top_k: 5, rerank_enabled: true };
}

export interface CitationOutput {
  index: number; chunk_id: string; doc_id: string; doc_title: string; page_range: number[];
  quote: string; score: number; source_status: string; anchor?: CitationAnchor | null;
}

export type AnswerStreamItem =
  | { type: 'delta'; text: string }
  | { type: 'replace'; text: string }
  | { type: 'citation'; citation: CitationOutput }
  | { type: 'completed'; confidence: Confidence; usage: Usage | null }
  | { type: 'failed'; code: string; message: string };

export interface AgentRun {
  assistant_message_id: string; mode: AgentMode;
  rewritten_query: string | null; retrieval_plan: RetrievalPlan;
  retrieval_traces: RetrievalTrace[];
  /** 移植自 Rust AnswerStream（tokio mpsc::UnboundedReceiver） */
  answerStream: AsyncGenerator<AnswerStreamItem>;
  trace: AgentTrace;
  no_answer_reason: import('./index.ts').NoAnswerReason | null;
}

export interface AgentTrace {
  mode: AgentMode; mode_reason: string; rewritten_query: string | null; keywords: string[];
  resolved_refs: ResolvedRef[]; retrieval_plan: RetrievalPlan; prompt_versions: PromptVersions;
  model: string; usage: Usage | null; started_at: string;
  memory_summary?: string; react_steps?: ReactStepTrace[]; stop_reason?: string;
  runtime_components?: RuntimeComponents; cache_key?: string | null;
}

export interface RuntimeComponents {
  reasoner?: string; retriever?: string; reranker?: string; verifier?: string;
}
export function defaultRuntimeComponents(): RuntimeComponents {
  return { reasoner: '', retriever: '', reranker: '', verifier: '' };
}

export interface ReactStepTrace {
  step: number; action: string; decision_summary: string; output?: string | null;
  tool_calls?: ReactToolCallTrace[]; queries?: string[]; rerank_query?: string | null;
  hypothetical_answer?: string | null; retrieved_chunk_ids?: string[]; accepted_chunk_ids?: string[];
  warnings?: string[]; started_at: string; completed_at: string;
}

export interface ReactToolCallTrace {
  id: string; name: string; arguments: unknown; status: string;
  result?: unknown; error?: unknown;
  started_at: string; completed_at: string; duration_ms: number;
}

export interface PromptVersions { persona: string; guardrail: string; mode: string; task: string; }

export interface RewriteOutput {
  rewritten_query: string; keywords: string[]; hypothetical_answer: string | null;
  resolved_refs: ResolvedRef[]; added_constraints: string[]; removed_constraints: string[];
  needs_clarification: boolean; clarification_question: string | null;
}
