// pi core 内核的领域支撑：证据合并、工具效果、React 步骤 Trace
import type { AnswerStream } from '../stream.ts';
import type { PreparedAgentRequest } from './kernel.ts';
import type {
  KnowledgeSearchEffect,
  TerminalToolEffect,
  ToolEffect,
} from './tools.ts';
import type {
  AgentMode,
  AgentRun,
  AgentTrace,
  AnswerStreamItem,
  ConversationTurn,
  PromptVersions,
  ReactStepTrace,
  ReactToolCallTrace,
  RuntimeComponents,
} from '../../models/agent.ts';
import type { RerankedChunk } from '../../models/rag.ts';
import type { PlanMode, ResolvedRef, RetrievalPlan, RetrievalTrace } from '../../models/trace.ts';
import { defaultRetrievalPlan } from '../../models/trace.ts';
import type { Confidence, NoAnswerReason, Usage } from '../../models/index.ts';
import { nowRfc3339 } from '../../infra/time.ts';

/** 本轮 runtime 组件标识；用于 Agent Trace 回放与灰度。 */
export interface KernelComponents {
  reasoner: string;
  search: string;
  verifier: string;
}

export function baseTrace(
  prepared: PreparedAgentRequest,
  components: KernelComponents,
): AgentTrace {
  const promptVersions: PromptVersions = {
    persona: prepared.prompt.persona_version,
    guardrail: prepared.prompt.guardrail_version,
    mode: prepared.prompt.mode_version,
    task: prepared.prompt.task_version,
  };
  const runtimeComponents: RuntimeComponents = {
    reasoner: components.reasoner,
    retriever: components.search,
    reranker: components.search,
    verifier: components.verifier,
  };
  return {
    mode: prepared.mode,
    mode_reason: 'pi-core native tool selection',
    rewritten_query: prepared.request.original_query,
    keywords: [],
    resolved_refs: [],
    retrieval_plan: defaultRetrievalPlan(),
    prompt_versions: promptVersions,
    model: prepared.request.options.generation.model,
    usage: { input_tokens: 0, output_tokens: 0 },
    started_at: prepared.started_at,
    memory_summary: '',
    react_steps: [],
    stop_reason: '',
    runtime_components: runtimeComponents,
    cache_key: null,
  };
}

export function buildRun(
  prepared: PreparedAgentRequest,
  mode: AgentMode,
  rewrittenQuery: string,
  trace: AgentTrace,
  retrievalPlan: RetrievalPlan,
  retrievalTraces: RetrievalTrace[],
  answerStream: AnswerStream,
  noAnswerReason: NoAnswerReason | null,
): AgentRun {
  return {
    assistant_message_id: prepared.request.assistant_message_id,
    mode: mode,
    rewritten_query: rewrittenQuery,
    retrieval_plan: retrievalPlan,
    retrieval_traces: retrievalTraces,
    answerStream: answerStream,
    trace: trace,
    no_answer_reason: noAnswerReason,
  };
}

export function boundedHistory(
  history: ConversationTurn[],
  maxTurns: number,
  maxChars: number,
): ConversationTurn[] {
  const selected: ConversationTurn[] = [];
  let used = 0;
  const turns = history.slice().reverse().slice(0, Math.max(maxTurns, 1));
  for (const turn of turns) {
    const citations = turn.citations ?? [];
    const size =
      charCount(turn.user_message) +
      charCount(turn.assistant_answer) +
      citations.reduce((sum, item) => sum + charCount(item), 0);
    if (selected.length > 0 && used + size > Math.max(maxChars, 1)) break;
    used += size;
    selected.push(turn);
  }
  selected.reverse();
  return selected;
}

/** 稳定证据编号：已有证据不重排，新证据只追加。 */
export function mergeEvidenceStable(
  existing: RerankedChunk[],
  incoming: RerankedChunk[],
  maxContextChars: number,
): number[] {
  const byId = new Map<string, number>();
  existing.forEach((item, index) => byId.set(item.chunk.chunk_id, index));
  let usedChars = existing.reduce((sum, item) => sum + charCount(item.chunk.content), 0);
  const ids: number[] = [];
  for (const item of incoming) {
    const existingIndex = byId.get(item.chunk.chunk_id);
    if (existingIndex !== undefined) {
      const current = existing[existingIndex];
      if (current !== undefined && item.score > current.score) existing[existingIndex] = item;
      ids.push(existingIndex + 1);
      continue;
    }
    const chars = charCount(item.chunk.content);
    if (existing.length > 0 && usedChars + chars > Math.max(maxContextChars, 1)) continue;
    usedChars += chars;
    existing.push(item);
    const index = existing.length - 1;
    const inserted = existing[index];
    if (inserted !== undefined) byId.set(inserted.chunk.chunk_id, index);
    ids.push(index + 1);
  }
  const unique = [...new Set(ids)];
  unique.sort((a, b) => a - b);
  return unique;
}

export function modelEvidencePayload(
  evidence: RerankedChunk[],
  ids: number[],
): Array<Record<string, unknown>> {
  const payload: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const item = id >= 1 ? evidence[id - 1] : undefined;
    if (!item) continue;
    payload.push({
      id: id,
      document: item.chunk.doc_title,
      heading_path: item.chunk.heading_path,
      pages: item.chunk.page_range,
      content: item.chunk.content,
      relevance_score: item.score,
    });
  }
  return payload;
}

export function singleTextStream(
  text: string,
  confidence: Confidence,
  usage: Usage | null,
): AnswerStream {
  const outputTokens = Math.floor(charCount(text) / 2);
  const finalUsage: Usage = usage ?? { input_tokens: 0, output_tokens: outputTokens };
  return (async function* (): AsyncGenerator<AnswerStreamItem> {
    yield { type: 'replace', text: text };
    yield { type: 'completed', confidence: confidence, usage: finalUsage };
  })();
}

export interface ToolState {
  evidence: RerankedChunk[];
  retrievalTraces: RetrievalTrace[];
  plan: RetrievalPlan;
  keywords: string[];
  resolvedRefs: ResolvedRef[];
  mode: AgentMode;
  rewrittenQuery: string;
  maxContextChars: number;
}

export interface AppliedToolTrace {
  queries: string[];
  rerankQuery: string | null;
  hypotheticalAnswer: string | null;
  retrievedChunkIds: string[];
  acceptedChunkIds: string[];
  warnings: string[];
}

export function emptyAppliedToolTrace(): AppliedToolTrace {
  return {
    queries: [],
    rerankQuery: null,
    hypotheticalAnswer: null,
    retrievedChunkIds: [],
    acceptedChunkIds: [],
    warnings: [],
  };
}

export interface AppliedToolEffect {
  modelResult: unknown;
  publicResult: unknown;
  terminal: TerminalToolEffect | null;
  documentSearchAttempted: boolean;
  trace: AppliedToolTrace;
}

export function applyToolEffect(
  effect: ToolEffect,
  modelResult: unknown,
  publicResult: unknown,
  state: ToolState,
): AppliedToolEffect {
  switch (effect.type) {
    case 'none':
      return {
        modelResult: modelResult,
        publicResult: publicResult,
        terminal: null,
        documentSearchAttempted: false,
        trace: emptyAppliedToolTrace(),
      };
    case 'knowledge_search':
      return applySearchEffect(effect.search, state);
    case 'terminal':
      return {
        modelResult: modelResult,
        publicResult: publicResult,
        terminal: effect.terminal,
        documentSearchAttempted: false,
        trace: emptyAppliedToolTrace(),
      };
  }
}

function applySearchEffect(
  search: KnowledgeSearchEffect,
  state: ToolState,
): AppliedToolEffect {
  const traceQueries = search.queries.map((query) => query.query);
  const evidenceIds = mergeEvidenceStable(state.evidence, search.chunks, state.maxContextChars);
  state.retrievalTraces.push(...search.retrieval_traces);
  state.plan.queries.push(...search.queries);
  const planMode: PlanMode = state.plan.queries.length > 1 ? 'multi_query' : 'single_query';
  state.plan.mode = planMode;
  mergeUniqueStrings(state.keywords, search.keywords);
  mergeResolvedRefs(state.resolvedRefs, search.resolved_refs);
  if (search.mode !== null) state.mode = search.mode;
  state.rewrittenQuery = search.rerank_query;
  const observations = modelEvidencePayload(state.evidence, evidenceIds);
  const acceptedChunkIds = evidenceIds
    .map((id) => (id >= 1 ? state.evidence[id - 1] : undefined))
    .filter((item): item is RerankedChunk => item !== undefined)
    .map((item) => item.chunk.chunk_id);
  const warnings = search.warnings;
  return {
    modelResult: {
      status: observations.length === 0 ? 'no_relevant_evidence' : 'evidence_ready',
      rerank_query: search.rerank_query,
      hypothetical_answer_used: search.hypothetical_answer !== null,
      document_evidence: observations,
      warnings: warnings,
    },
    publicResult: {
      accepted_evidence_ids: evidenceIds,
      accumulated_evidence_count: state.evidence.length,
      warnings: warnings,
    },
    terminal: null,
    documentSearchAttempted: true,
    trace: {
      queries: traceQueries,
      rerankQuery: state.rewrittenQuery,
      hypotheticalAnswer: search.hypothetical_answer,
      retrievedChunkIds: search.retrieved_chunk_ids,
      acceptedChunkIds: acceptedChunkIds,
      warnings: warnings,
    },
  };
}

function mergeUniqueStrings(existing: string[], incoming: string[]): void {
  for (const item of incoming) {
    if (item.trim().length > 0 && !existing.includes(item)) existing.push(item);
  }
}

function mergeResolvedRefs(existing: ResolvedRef[], incoming: ResolvedRef[]): void {
  for (const item of incoming) {
    const duplicate = existing.some(
      (candidate) => candidate.text === item.text && candidate.resolved_to === item.resolved_to,
    );
    if (!duplicate) existing.push(item);
  }
}

export function toolStepSummary(names: string[]): string {
  return 'model selected tools: ' + names.join(', ');
}

export interface ToolCallDescriptor {
  id: string;
  name: string;
  argumentsValue: unknown;
}

export function successfulToolStep(
  step: number,
  call: ToolCallDescriptor,
  result: unknown,
  output: string | null,
  details: AppliedToolTrace,
  startedAt: string,
): ReactStepTrace {
  const completedAt = nowRfc3339();
  const toolCall: ReactToolCallTrace = {
    id: call.id,
    name: call.name,
    arguments: call.argumentsValue,
    status: 'succeeded',
    result: result,
    error: undefined,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
  };
  return {
    step: step,
    action: call.name,
    decision_summary: 'executed ' + call.name,
    output: output,
    tool_calls: [toolCall],
    queries: [...details.queries],
    rerank_query: details.rerankQuery,
    hypothetical_answer: details.hypotheticalAnswer,
    retrieved_chunk_ids: [...details.retrievedChunkIds],
    accepted_chunk_ids: [...details.acceptedChunkIds],
    warnings: [...details.warnings],
    started_at: startedAt,
    completed_at: completedAt,
  };
}

export function failedToolStep(
  step: number,
  call: ToolCallDescriptor,
  error: unknown,
  output: string | null,
  message: string,
  startedAt: string,
): ReactStepTrace {
  const completedAt = nowRfc3339();
  const toolCall: ReactToolCallTrace = {
    id: call.id,
    name: call.name,
    arguments: call.argumentsValue,
    status: 'failed',
    result: undefined,
    error: error,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
  };
  return {
    step: step,
    action: call.name,
    decision_summary: call.name + ' failed',
    output: output,
    tool_calls: [toolCall],
    queries: [],
    rerank_query: null,
    hypothetical_answer: null,
    retrieved_chunk_ids: [],
    accepted_chunk_ids: [],
    warnings: [message],
    started_at: startedAt,
    completed_at: completedAt,
  };
}

export function responseStep(step: number, content: string): ReactStepTrace {
  const timestamp = nowRfc3339();
  return {
    step: step,
    action: 'respond',
    decision_summary: 'final response (' + charCount(content) + ' chars)',
    output: content,
    tool_calls: [],
    queries: [],
    rerank_query: null,
    hypothetical_answer: null,
    retrieved_chunk_ids: [],
    accepted_chunk_ids: [],
    warnings: [],
    started_at: timestamp,
    completed_at: timestamp,
  };
}

export function failedResponseStep(
  step: number,
  content: string,
  message: string,
): ReactStepTrace {
  const timestamp = nowRfc3339();
  return {
    step: step,
    action: 'respond',
    decision_summary: 'response rejected',
    output: content,
    tool_calls: [],
    queries: [],
    rerank_query: null,
    hypothetical_answer: null,
    retrieved_chunk_ids: [],
    accepted_chunk_ids: [],
    warnings: [message],
    started_at: timestamp,
    completed_at: timestamp,
  };
}

export function charCount(text: string): number {
  return [...text].length;
}
