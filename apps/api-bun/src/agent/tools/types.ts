// 移植自 apps/api-rs/src/agent/tools/mod.rs
import type { AgentToolCall, AgentToolDefinition } from '../model.ts';
import type { AgentRequest, AgentMode } from '../../models/agent.ts';
import type { RerankedChunk } from '../../models/rag.ts';
import type { ResolvedRef, RetrievalTrace, SubQuery } from '../../models/trace.ts';
import type { Confidence, NoAnswerReason } from '../../models/index.ts';
import type { ProgressSender } from '../events.ts';

export interface AgentToolContext {
  request: AgentRequest;
  progress: ProgressSender;
}

export interface KnowledgeSearchEffect {
  chunks: RerankedChunk[];
  retrieval_traces: RetrievalTrace[];
  retrieved_chunk_ids: string[];
  queries: SubQuery[];
  rerank_query: string;
  hypothetical_answer: string | null;
  keywords: string[];
  resolved_refs: ResolvedRef[];
  warnings: string[];
  mode: AgentMode | null;
}

export interface TerminalToolEffect {
  answer: string;
  mode: AgentMode;
  confidence: Confidence;
  no_answer_reason: NoAnswerReason | null;
}

export type ToolEffect =
  | { type: 'none' }
  | { type: 'knowledge_search'; search: KnowledgeSearchEffect }
  | { type: 'terminal'; terminal: TerminalToolEffect };

export interface ToolExecution {
  public_result: unknown;
  model_result: unknown;
  effect: ToolEffect;
}

export interface AgentTool {
  definition(): AgentToolDefinition;
  execute(call: AgentToolCall, context: AgentToolContext): Promise<ToolExecution>;
  componentName(): string;
}
