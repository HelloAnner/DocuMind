// pi core 工具：knowledge_search / ask_clarification
import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { emit, type AgentProgress, type ProgressSender } from '../events.ts';
import { rerankedTraces, retrievedTraces } from '../trace_builder.ts';
import { isAgentMode, type AgentMode, type AgentRequest } from '../../models/agent.ts';
import type { Reranker, Retriever } from '../../rag/types.ts';
import type { ResolvedRef, SubQuery } from '../../models/trace.ts';
import type { Confidence, NoAnswerReason } from '../../models/index.ts';
import {
  applyToolEffect,
  type AppliedToolEffect,
  type ToolState,
} from './support.ts';

export interface KnowledgeSearchEffect {
  chunks: import('../../models/rag.ts').RerankedChunk[];
  retrieval_traces: import('../../models/trace.ts').RetrievalTrace[];
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

/** 工具执行后交给内核的领域结果。 */
export interface ToolOutcome {
  modelResult: unknown;
  publicResult: unknown;
  effect: ToolEffect;
}

/** 工具运行上下文：请求、进度、共享状态与效果回传。 */
export interface ToolRunContext {
  request: AgentRequest;
  progress: ProgressSender;
  state: ToolState;
  retriever: Retriever;
  reranker: Reranker;
  recordApplied(callId: string, applied: AppliedToolEffect): void;
  recordClarification(terminal: TerminalToolEffect): void;
}

const RESPONSE_MODES = ['answerer', 'summarizer', 'comparer', 'analyst', 'navigator', 'reviewer'] as const;

const knowledgeSearchParameters = Type.Object({
  queries: Type.Array(Type.String(), {
    minItems: 1,
    description: 'Self-contained semantic queries covering only requested facts.',
  }),
  rerank_query: Type.String({
    description: 'Self-contained query used to rerank the combined results.',
  }),
  hypothetical_answer: Type.Optional(Type.String({
    description: 'Optional HyDE retrieval aid. It is never evidence.',
  })),
  response_mode: Type.Optional(Type.Union(
    RESPONSE_MODES.map((mode) => Type.Literal(mode)),
    { description: 'Optional semantic response style for the final answer.' },
  )),
  keywords: Type.Optional(Type.Array(Type.String(), {
    description: 'Optional concise search terms for the query trace.',
  })),
  resolved_references: Type.Optional(Type.Array(
    Type.Object({
      text: Type.String(),
      resolved_to: Type.String(),
    }),
    { description: 'Optional unambiguous references resolved from conversation history.' },
  )),
  reason: Type.String({
    description: 'Brief operational search purpose without hidden reasoning.',
  }),
}, { additionalProperties: false });

type KnowledgeSearchParams = Static<typeof knowledgeSearchParameters>;

const clarificationParameters = Type.Object({
  question: Type.String({ description: 'One concise user-facing clarification question.' }),
  reason: Type.String({ description: 'Brief operational reason; do not expose hidden reasoning.' }),
}, { additionalProperties: false });

type ClarificationParams = Static<typeof clarificationParameters>;

function textResult(text: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: text }];
}

function normalizeQueries(raw: string[], maxQueries: number): string[] {
  const cleaned = raw.map((query) => query.trim()).filter((query) => query.length > 0);
  return cleaned.slice(0, Math.max(maxQueries, 1));
}

/** knowledge_search：授权范围内的混合检索 + 精排，返回稳定证据编号。 */
export function createKnowledgeSearchTool(
  retriever: Retriever,
  reranker: Reranker,
  context: ToolRunContext,
): AgentTool<typeof knowledgeSearchParameters, unknown> {
  return {
    name: 'knowledge_search',
    label: 'Knowledge Search',
    description:
      'Search only the user\'s authorized DocuMind knowledge bases, then rerank and return stable evidence ids for grounded answers. Use for organization-specific document facts, policies, contracts, records, summaries, comparisons, navigation, analysis, and review.',
    parameters: knowledgeSearchParameters,
    execute: async (toolCallId, params: KnowledgeSearchParams): Promise<AgentToolResult<unknown>> => {
      const outcome = await runKnowledgeSearch(params, context);
      const applied = applyToolEffect(
        outcome.effect, outcome.modelResult, outcome.publicResult, context.state,
      );
      context.recordApplied(toolCallId, applied);
      return {
        content: textResult(JSON.stringify(applied.modelResult)),
        details: applied.publicResult,
      };
    },
  };
}

async function runKnowledgeSearch(
  params: KnowledgeSearchParams,
  context: ToolRunContext,
): Promise<ToolOutcome> {
  const runtime = context.request.options.runtime;
  const queries = normalizeQueries(params.queries, runtime.max_queries_per_step);
  if (queries.length === 0) {
    throw new Error('knowledge_search requires at least one non-empty query');
  }
  const rerankQuery = params.rerank_query.trim();
  if (rerankQuery.length === 0) {
    throw new Error('knowledge_search requires a non-empty rerank_query');
  }
  if (params.response_mode === 'analyst' && !context.request.options.allow_analyst_mode) {
    throw new Error('analyst response mode is disabled for this request');
  }

  const progress = context.progress;
  emit(progress, { type: 'status_updated', status: 'retrieving' } satisfies AgentProgress);
  const retrieval = await retrieverCall(context, queries, params.hypothetical_answer);
  const warnings = retrieval.warnings ?? [];
  const retrieved = retrieval.chunks;
  const retrievedChunkIds = retrieved.map((item) => item.chunk_id);
  const traces = retrievedTraces(context.request.user_message_id, retrieved);
  emit(progress, {
    type: 'retrieval_completed',
    chunk_count: retrieved.length,
    warnings: [...warnings],
  } satisfies AgentProgress);

  emit(progress, { type: 'status_updated', status: 'reranking' } satisfies AgentProgress);
  const reranked = await context.reranker.rerank({
    query: rerankQuery,
    chunks: retrieved,
    top_k: Math.max(context.request.options.retrieval.rerank_top_k, 1),
  });
  traces.push(...rerankedTraces(context.request.user_message_id, reranked));
  const topChunkIds = reranked.map((item) => item.chunk.chunk_id);
  emit(progress, {
    type: 'rerank_completed',
    top_chunk_ids: [...topChunkIds],
  } satisfies AgentProgress);

  const subQueries: SubQuery[] = queries.map((query) => ({
    query: query,
    reason: params.reason,
  }));
  const resolvedRefs: ResolvedRef[] = (params.resolved_references ?? [])
    .filter((item) => item.text.trim().length > 0 && item.resolved_to.trim().length > 0)
    .map((item) => ({
      text: item.text,
      resolved_to: item.resolved_to,
      source_message_id: null,
      evidence_message_id: null,
    }));
  return {
    publicResult: {
      retrieved_chunk_count: topChunkIds.length,
      top_chunk_ids: topChunkIds,
      warnings: [...warnings],
    },
    modelResult: {
      status: 'evidence_ready',
      message: 'Evidence ids are assigned by the runtime.',
    },
    effect: {
      type: 'knowledge_search',
      search: {
        chunks: reranked,
        retrieval_traces: traces,
        retrieved_chunk_ids: retrievedChunkIds,
        queries: subQueries,
        rerank_query: rerankQuery,
        hypothetical_answer: params.hypothetical_answer ?? null,
        keywords: params.keywords ?? [],
        resolved_refs: resolvedRefs,
        warnings: warnings,
        mode: params.response_mode ?? null,
      },
    },
  };
}

async function retrieverCall(
  context: ToolRunContext,
  queries: string[],
  hypotheticalAnswer: string | undefined,
): Promise<import('../../models/rag.ts').RetrievalOutput> {
  const request = context.request;
  return context.retriever.retrieve({
    tenant_id: request.tenant_id,
    effective_kb_ids: [...request.effective_kb_ids],
    queries: [...queries],
    hypothetical_answer: request.options.runtime.hyde_enabled
      ? (hypotheticalAnswer ?? null)
      : null,
    top_k: Math.max(request.options.retrieval.rrf_top_k, 1),
    dense_top_k: Math.max(request.options.retrieval.dense_top_k, 1),
    bm25_top_k: Math.max(request.options.retrieval.bm25_top_k, 1),
  });
}

/** ask_clarification：真实意图歧义时终止本轮并等待用户。 */
export function createClarificationTool(
  context: ToolRunContext,
): AgentTool<typeof clarificationParameters, unknown> {
  return {
    name: 'ask_clarification',
    label: 'Ask Clarification',
    description:
      'Pause and ask one precise question when the user\'s intent is genuinely ambiguous. Do not use this for missing evidence or uncertain corpus contents.',
    parameters: clarificationParameters,
    execute: async (toolCallId, params: ClarificationParams): Promise<AgentToolResult<unknown>> => {
      const question = params.question.trim();
      if (question.length === 0) {
        throw new Error('ask_clarification requires a non-empty question');
      }
      const outcome: ToolOutcome = {
        publicResult: { question: question, reason: params.reason, status: 'waiting_for_user' },
        modelResult: { status: 'waiting_for_user', question: question },
        effect: {
          type: 'terminal',
          terminal: {
            answer: question,
            mode: 'clarifier',
            confidence: 'low',
            no_answer_reason: 'needs_clarification',
          },
        },
      };
      const applied = applyToolEffect(
        outcome.effect, outcome.modelResult, outcome.publicResult, context.state,
      );
      context.recordApplied(toolCallId, applied);
      if (applied.terminal !== null) context.recordClarification(applied.terminal);
      return {
        content: textResult(JSON.stringify(applied.modelResult)),
        details: applied.publicResult,
      };
    },
  };
}

export { isAgentMode };
