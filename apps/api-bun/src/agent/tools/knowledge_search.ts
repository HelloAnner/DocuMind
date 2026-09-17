// 移植自 apps/api-rs/src/agent/tools/knowledge_search.rs
import { emit, type AgentProgress } from '../events.ts';
import type { AgentToolCall, AgentToolDefinition } from '../model.ts';
import { rerankedTraces, retrievedTraces } from '../trace_builder.ts';
import { isAgentMode, type AgentMode } from '../../models/agent.ts';
import type { Reranker, Retriever } from '../../rag/types.ts';
import type { ResolvedRef, SubQuery } from '../../models/trace.ts';
import type { AgentTool, AgentToolContext, ToolExecution } from './types.ts';

interface ResolvedReferenceArgument {
  text: string;
  resolved_to: string;
}

interface KnowledgeSearchArguments {
  queries: string[];
  rerank_query: string;
  hypothetical_answer: string | null;
  response_mode: AgentMode | null;
  keywords: string[];
  resolved_references: ResolvedReferenceArgument[];
  reason: string;
}

function parseResponseMode(value: unknown): AgentMode | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !isAgentMode(value)) {
    throw new Error(`unknown agent mode: ${String(value)}`);
  }
  return value;
}

function parseKnowledgeSearchArguments(argumentsJson: string): KnowledgeSearchArguments {
  let value: unknown;
  try {
    value = JSON.parse(argumentsJson);
  } catch (error) {
    throw new Error(`invalid knowledge_search arguments: ${(error as Error).message}`);
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('invalid knowledge_search arguments: expected an object');
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.queries) || !record.queries.every((item) => typeof item === 'string')) {
    throw new Error('invalid knowledge_search arguments: missing field \`queries\`');
  }
  if (typeof record.rerank_query !== 'string') {
    throw new Error('invalid knowledge_search arguments: missing field \`rerank_query\`');
  }
  if (typeof record.reason !== 'string') {
    throw new Error('invalid knowledge_search arguments: missing field \`reason\`');
  }
  const keywords = Array.isArray(record.keywords)
    ? record.keywords.filter((item): item is string => typeof item === 'string')
    : [];
  const resolvedReferences: ResolvedReferenceArgument[] = [];
  if (Array.isArray(record.resolved_references)) {
    for (const item of record.resolved_references) {
      if (typeof item !== 'object' || item === null) continue;
      const ref = item as Record<string, unknown>;
      if (typeof ref.text !== 'string' || typeof ref.resolved_to !== 'string') {
        throw new Error(
          'invalid knowledge_search arguments: missing field \`resolved_references.text\` or \`resolved_references.resolved_to\`',
        );
      }
      resolvedReferences.push({ text: ref.text, resolved_to: ref.resolved_to });
    }
  }
  return {
    queries: [...(record.queries as string[])],
    rerank_query: record.rerank_query,
    hypothetical_answer: typeof record.hypothetical_answer === 'string' ? record.hypothetical_answer : null,
    response_mode: parseResponseMode(record.response_mode),
    keywords,
    resolved_references: resolvedReferences,
    reason: record.reason,
  };
}

export class KnowledgeSearchTool implements AgentTool {
  constructor(
    private readonly retriever: Retriever,
    private readonly reranker: Reranker,
  ) {}

  definition(): AgentToolDefinition {
    return {
      name: 'knowledge_search',
      description: 'Search only the user\'s authorized DocuMind knowledge bases, then rerank and return stable evidence ids for grounded answers. Use for organization-specific document facts, policies, contracts, records, summaries, comparisons, navigation, analysis, and review.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queries: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Self-contained semantic queries covering only requested facts.',
          },
          rerank_query: {
            type: 'string',
            description: 'Self-contained query used to rerank the combined results.',
          },
          hypothetical_answer: {
            type: 'string',
            description: 'Optional HyDE retrieval aid. It is never evidence.',
          },
          response_mode: {
            type: 'string',
            enum: ['answerer', 'summarizer', 'comparer', 'analyst', 'navigator', 'reviewer'],
            description: 'Optional semantic response style for the final answer.',
          },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional concise search terms for the query trace.',
          },
          resolved_references: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string' },
                resolved_to: { type: 'string' },
              },
              required: ['text', 'resolved_to'],
            },
            description: 'Optional unambiguous references resolved from conversation history.',
          },
          reason: {
            type: 'string',
            description: 'Brief operational search purpose without hidden reasoning.',
          },
        },
        required: ['queries', 'rerank_query', 'reason'],
      },
    };
  }

  async execute(call: AgentToolCall, context: AgentToolContext): Promise<ToolExecution> {
    const arguments_ = parseKnowledgeSearchArguments(call.arguments_json);
    arguments_.queries = arguments_.queries.filter((query) => query.trim().length > 0);
    arguments_.queries = arguments_.queries.slice(
      0,
      Math.max(context.request.options.runtime.max_queries_per_step, 1),
    );
    if (arguments_.queries.length === 0) {
      throw new Error('knowledge_search requires at least one non-empty query');
    }
    if (arguments_.rerank_query.trim().length === 0) {
      throw new Error('knowledge_search requires a non-empty rerank_query');
    }
    if (arguments_.response_mode === 'analyst' && !context.request.options.allow_analyst_mode) {
      throw new Error('analyst response mode is disabled for this request');
    }

    const progress = context.progress;
    emit(progress, { type: 'status_updated', status: 'retrieving' } satisfies AgentProgress);
    const retrieval = await this.retriever.retrieve({
      tenant_id: context.request.tenant_id,
      effective_kb_ids: [...context.request.effective_kb_ids],
      queries: [...arguments_.queries],
      hypothetical_answer: context.request.options.runtime.hyde_enabled
        ? arguments_.hypothetical_answer
        : null,
      top_k: Math.max(context.request.options.retrieval.rrf_top_k, 1),
      dense_top_k: Math.max(context.request.options.retrieval.dense_top_k, 1),
      bm25_top_k: Math.max(context.request.options.retrieval.bm25_top_k, 1),
    });
    const warnings = retrieval.warnings ?? [];
    const retrieved = retrieval.chunks;
    const retrieved_chunk_ids = retrieved.map((item) => item.chunk_id);
    const traces = retrievedTraces(context.request.user_message_id, retrieved);
    emit(progress, {
      type: 'retrieval_completed',
      chunk_count: retrieved.length,
      warnings: [...warnings],
    } satisfies AgentProgress);

    emit(progress, { type: 'status_updated', status: 'reranking' } satisfies AgentProgress);
    const reranked = await this.reranker.rerank({
      query: arguments_.rerank_query,
      chunks: retrieved,
      top_k: Math.max(context.request.options.retrieval.rerank_top_k, 1),
    });
    traces.push(...rerankedTraces(context.request.user_message_id, reranked));
    const top_chunk_ids = reranked.map((item) => item.chunk.chunk_id);
    emit(progress, { type: 'rerank_completed', top_chunk_ids: [...top_chunk_ids] } satisfies AgentProgress);

    const queries: SubQuery[] = arguments_.queries.map((query) => ({
      query: query,
      reason: arguments_.reason,
    }));
    const resolved_refs: ResolvedRef[] = arguments_.resolved_references
      .filter((item) => item.text.trim().length > 0 && item.resolved_to.trim().length > 0)
      .map((item) => ({
        text: item.text,
        resolved_to: item.resolved_to,
        source_message_id: null,
        evidence_message_id: null,
      }));
    return {
      public_result: {
        retrieved_chunk_count: top_chunk_ids.length,
        top_chunk_ids: top_chunk_ids,
        warnings: [...warnings],
      },
      model_result: {
        status: 'evidence_ready',
        message: 'Evidence ids are assigned by the runtime.',
      },
      effect: {
        type: 'knowledge_search',
        search: {
          chunks: reranked,
          retrieval_traces: traces,
          retrieved_chunk_ids: retrieved_chunk_ids,
          queries: queries,
          rerank_query: arguments_.rerank_query,
          hypothetical_answer: arguments_.hypothetical_answer,
          keywords: arguments_.keywords,
          resolved_refs: resolved_refs,
          warnings: warnings,
          mode: arguments_.response_mode,
        },
      },
    };
  }

  componentName(): string {
    return `knowledge-search:${this.retriever.componentName()}+${this.reranker.componentName()}`;
  }
}
