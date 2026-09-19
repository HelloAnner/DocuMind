// pi core 工具：knowledge_search / ask_clarification
import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Sql } from 'postgres';
import { emit, type AgentProgress, type ProgressSender } from '../events.ts';
import { rerankedTraces, retrievedTraces } from '../trace_builder.ts';
import { isAgentMode, type AgentMode, type AgentRequest } from '../../models/agent.ts';
import type { Reranker, Retriever } from '../../rag/types.ts';
import type { ResolvedRef, SubQuery } from '../../models/trace.ts';
import type { RerankedChunk } from '../../models/rag.ts';
import type { Confidence, NoAnswerReason } from '../../models/index.ts';
import {
  applyToolEffect,
  type AppliedToolEffect,
  type ToolState,
} from './support.ts';
import { getSkill, saveSkill } from '../../api/admin_skills.ts';

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
  sql: Sql | null;
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
const skillReadParameters = Type.Object({
  name: Type.String({ description: '技能英文名称' }),
}, { additionalProperties: false });
type SkillReadParams = Static<typeof skillReadParameters>;

const skillSaveParameters = Type.Object({
  name: Type.String({ description: '小写英文、数字和连字符组成的技能名称' }),
  display_name: Type.String({ description: '技能显示名称' }),
  description: Type.String({ description: '技能适用场景的一句话说明' }),
  content: Type.String({ description: '完整 Markdown 执行指令' }),
}, { additionalProperties: false });
type SkillSaveParams = Static<typeof skillSaveParameters>;


function textResult(text: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: text }];
}

function normalizeQueries(raw: string[], maxQueries: number, originalQuery: string): string[] {
  const limit = Math.max(maxQueries, 1);
  const generated = [...new Set(raw.map((query) => query.trim()).filter((query) => query.length > 0))];
  const original = originalQuery.trim();
  if (original.length === 0) return generated.slice(0, limit);
  // ponytail: two literal clauses cover normal comparisons; add query planning if larger lists recur.
  const literal = [...new Set(original.split(/[;；]+/).map((query) => query.trim()).filter(Boolean))]
    .slice(0, Math.min(2, limit));
  const literalSet = new Set(literal);
  return [
    ...generated.filter((query) => !literalSet.has(query)).slice(0, limit),
    ...literal,
  ];
}

export function mergeCoveredReranks(
  perQuery: RerankedChunk[][],
  global: RerankedChunk[],
  topK: number,
): RerankedChunk[] {
  const merged: RerankedChunk[] = [];
  const seen = new Set<string>();
  const covered = perQuery.flatMap((items) => items.slice(0, 1));
  for (const item of [...covered, ...global]) {
    if (seen.has(item.chunk.chunk_id)) continue;
    seen.add(item.chunk.chunk_id);
    merged.push({ ...item, rank: merged.length + 1 });
    if (merged.length >= topK) break;
  }
  return merged;
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
export function createSkillReadTool(
  context: ToolRunContext,
): AgentTool<typeof skillReadParameters, unknown> {
  return {
    name: 'skill_read',
    label: 'Read Skill',
    description: '按技能名称加载当前租户技能的完整指令和参考文件。仅在确认技能适用后调用。',
    parameters: skillReadParameters,
    execute: async (toolCallId, params: SkillReadParams): Promise<AgentToolResult<unknown>> => {
      if (!context.sql) throw new Error('技能服务需要 PostgreSQL');
      const skill = await getSkill(context.sql, context.request.tenant_id, params.name);
      const publicResult = {
        name: skill.name, display_name: skill.display_name, description: skill.description,
        content: skill.content, references: skill.files, revision: skill.revision,
      };
      const applied = applyToolEffect({ type: 'none' }, publicResult, publicResult, context.state);
      context.recordApplied(toolCallId, applied);
      return { content: textResult(JSON.stringify(publicResult)), details: publicResult };
    },
  };
}

export function createSkillSaveTool(
  context: ToolRunContext,
): AgentTool<typeof skillSaveParameters, unknown> {
  return {
    name: 'skill_save',
    label: 'Save Skill',
    description: '将当前对话中确认的流程保存为租户技能。仅在用户明确要求创建或保存技能后调用。',
    parameters: skillSaveParameters,
    execute: async (toolCallId, params: SkillSaveParams): Promise<AgentToolResult<unknown>> => {
      if (!context.request.can_manage_skills) throw new Error('当前用户无权创建技能');
      if (!context.sql) throw new Error('技能服务需要 PostgreSQL');
      const skill = await saveSkill(
        context.sql, context.request.tenant_id, context.request.user_id,
        { ...params, source: 'conversation' },
      );
      const publicResult = {
        message: `技能「${skill.display_name}」已创建`,
        interaction: {
          kind: 'skill_card',
          action: 'created',
          skill: {
            id: skill.id, name: skill.name, display_name: skill.display_name,
            description: skill.description, revision: skill.revision,
          },
        },
      };
      const applied = applyToolEffect({ type: 'none' }, publicResult, publicResult, context.state);
      context.recordApplied(toolCallId, applied);
      return { content: textResult(JSON.stringify(publicResult)), details: publicResult };
    },
  };
}


async function runKnowledgeSearch(
  params: KnowledgeSearchParams,
  context: ToolRunContext,
): Promise<ToolOutcome> {
  const runtime = context.request.options.runtime;
  const queries = normalizeQueries(
    params.queries,
    runtime.max_queries_per_step,
    context.request.original_query,
  );
  if (queries.length === 0) {
    throw new Error('knowledge_search requires at least one non-empty query');
  }
  const rerankQuery = [...new Set([
    params.rerank_query.trim(),
    context.request.original_query.trim(),
  ].filter((query) => query.length > 0))].join('\n');
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

  const rerankTopK = Math.max(context.request.options.retrieval.rerank_top_k, 1);
  const [globalReranked, ...perQueryReranked] = await Promise.all([
    context.reranker.rerank({
      query: rerankQuery,
      chunks: retrieved,
      top_k: rerankTopK,
    }),
    ...queries.map((query) => context.reranker.rerank({
      query: query,
      chunks: retrieved,
      top_k: 1,
    })),
  ]);
  const reranked = mergeCoveredReranks(perQueryReranked, globalReranked, rerankTopK);
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
