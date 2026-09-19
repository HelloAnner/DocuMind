// 移植自 apps/api-rs/src/api/conversations.rs 的 Agent 执行管线
import type { Sql } from 'postgres';
import type { ProgressSender } from '../agent/events.ts';
import type { PiAgentKernel } from '../agent/pi/kernel.ts';
import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import { nowRfc3339 } from '../infra/time.ts';
import { newUuid } from '../infra/uuid.ts';
import type {
  AgentOptions, AgentRequest, AgentRun, AgentTrace, CitationOutput, ConversationTurn,
} from '../models/agent.ts';
import type { Citation } from '../models/citation.ts';
import type { CurrentActor } from '../models/identity.ts';
import type { Confidence, NoAnswerReason, Usage } from '../models/index.ts';
import type { ConversationMessage } from '../models/message.ts';
import type { QueryTrace, RetrievalTrace } from '../models/trace.ts';
import type { ConversationRepository } from '../repositories/types.ts';
import {
  sendAnswerCompleted, sendAnswerDelta, sendAnswerFailed, sendAnswerReplace,
  sendCitationDelta, sendConversationTitleUpdated, sendExecutionCancelled, sendProgressEvent,
  type PipelineContext,
} from './conversations_sse.ts';

export interface AgentPipelineOptions {
  repo: ConversationRepository;
  kernel: PiAgentKernel;
  config: AppConfig;
  /** 对应 Rust 的 state.db_pool: Option<PgPool> */
  sql: Sql | null;
  actor: CurrentActor;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  originalQuery: string;
  effectiveKbIds: string[];
  ctx: PipelineContext;
  /** 对应 Rust spawn_title_update 的 JoinHandle；重试路径为 null。 */
  titleUpdate: Promise<string | null> | null;
}

/** 对应 Rust run_agent_pipeline：整轮执行加总超时，超时/异常都要落一条失败助手消息。 */
export async function runAgentPipeline(options: AgentPipelineOptions): Promise<void> {
  const { repo, ctx } = options;
  const timeoutSeconds = Math.max(options.config.agent.totalTimeoutSeconds, 1);
  const tenantId = options.actor.tenant_id;

  const pipeline = runAgentPipelineInner(options).then(
    () => ({ outcome: 'ok' as const }),
    (error: unknown) => ({ outcome: 'error' as const, error: error }),
  );
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ outcome: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: 'timeout' }), timeoutSeconds * 1000);
  });
  const settled = await Promise.race([pipeline, timeout]);
  if (timer !== null) clearTimeout(timer);

  if (settled.outcome === 'error') {
    console.error(
      '[documind][conversations] agent pipeline returned an error: ' + describeError(settled.error));
    await failAssistantMessage(
      repo, tenantId, options.assistantMessageId,
      'PIPELINE_ERROR', 'Agent pipeline failed; retry this message', ctx);
  } else if (settled.outcome === 'timeout') {
    await failAssistantMessage(
      repo, tenantId, options.assistantMessageId, 'PIPELINE_TIMEOUT',
      'Agent execution exceeded ' + timeoutSeconds + ' seconds', ctx);
    // Rust 侧 timeout 会 drop 掉 future 从而停止后续事件；这里用 abandoned 达到同样效果。
    // 标题事件单独放行，所以用独立的 ctx。
    ctx.abandoned = true;
  }

  if (options.titleUpdate !== null) {
    const title = await options.titleUpdate;
    if (title !== null) {
      sendConversationTitleUpdated(
        { sink: ctx.sink, protocol: ctx.protocol, factory: ctx.factory, abandoned: false },
        options.conversationId, title);
    }
  }
}

async function runAgentPipelineInner(options: AgentPipelineOptions): Promise<void> {
  const { repo, config, ctx, actor } = options;
  const history = await buildHistory(
    options.sql, repo, actor.tenant_id, options.conversationId, options.userMessageId);
  const agentRequest: AgentRequest = {
    tenant_id: actor.tenant_id,
    user_id: actor.user_id,
    conversation_id: options.conversationId,
    user_message_id: options.userMessageId,
    assistant_message_id: options.assistantMessageId,
    original_query: options.originalQuery,
    effective_kb_ids: options.effectiveKbIds,
    can_manage_skills: actor.is_super_admin || actor.roles.some((role) =>
      ['tenant_owner', 'tenant_admin', 'enterprise_admin'].includes(role)),
    history: history,
    options: agentOptionsFromConfig(config),
  };
  const progress: ProgressSender =
    (event) => sendProgressEvent(ctx, options.assistantMessageId, event);

  // Rust: kernel.prepare() 在管线外抛错 → 外层 PIPELINE_ERROR；run_prepared 的错才带原始信息。
  const prepared = await options.kernel.prepare(agentRequest);
  let run: AgentRun;
  try {
    run = await options.kernel.runPrepared(prepared, progress);
  } catch (error) {
    await failAssistantMessage(
      repo, actor.tenant_id, options.assistantMessageId, 'PIPELINE_ERROR',
      describeError(error), ctx);
    return;
  }

  const mode = run.mode;
  const rewrittenQuery = run.rewritten_query;
  const trace = run.trace;
  const agentNoAnswerReason = run.no_answer_reason;
  const pipelineRetrievalTraces = run.retrieval_traces;

  let answerText = '';
  const citations: CitationOutput[] = [];
  let confidence: Confidence = 'low';
  let usage: Usage | null = null;
  let failed: { code: string; message: string } | null = null;

  for await (const item of run.answerStream) {
    if (await assistantMessageCancelled(repo, actor.tenant_id, options.assistantMessageId)) {
      sendExecutionCancelled(ctx);
      return;
    }
    switch (item.type) {
      case 'delta':
        answerText += item.text;
        sendAnswerDelta(ctx, options.assistantMessageId, item.text);
        break;
      case 'replace':
        answerText = item.text;
        sendAnswerReplace(ctx, options.assistantMessageId, item.text);
        break;
      case 'citation':
        citations.push(item.citation);
        sendCitationDelta(ctx, options.assistantMessageId, item.citation);
        break;
      case 'completed':
        confidence = item.confidence;
        usage = item.usage;
        break;
      case 'failed':
        failed = { code: item.code, message: item.message };
        break;
    }
  }

  // 超时后管线已被放弃：不再写库、不再发事件（对齐 Rust drop 掉 future 的语义）。
  if (ctx.abandoned) return;

  const noAnswerReason: NoAnswerReason | null =
    confidence === 'low' && citations.length === 0
      ? (agentNoAnswerReason ?? 'no_relevant_chunks')
      : agentNoAnswerReason;

  if (failed !== null) {
    sendAnswerFailed(ctx, options.assistantMessageId, failed.code, failed.message);
    const failedMessage = await repo.getMessage(actor.tenant_id, options.assistantMessageId);
    if (failedMessage === null) throw AppError.messageNotFound();
    failedMessage.status = 'failed';
    failedMessage.error_code = failed.code;
    failedMessage.error_message = failed.message;
    failedMessage.completed_at = nowRfc3339();
    await repo.updateMessage(failedMessage);
    return;
  }

  if (await assistantMessageCancelled(repo, actor.tenant_id, options.assistantMessageId)) {
    sendExecutionCancelled(ctx);
    return;
  }
  const message = await repo.getMessage(actor.tenant_id, options.assistantMessageId);
  if (message === null) throw AppError.messageNotFound();
  message.content = answerText;
  message.status = 'completed';
  message.confidence = confidence;
  message.no_answer_reason = noAnswerReason;
  message.agent_mode = mode;
  message.prompt_versions = trace.prompt_versions;
  message.completed_at = nowRfc3339();
  await repo.updateMessage(message);

  const queryTrace: QueryTrace = {
    id: newUuid(),
    message_id: options.userMessageId,
    original_query: options.originalQuery,
    rewritten_query: rewrittenQuery,
    keywords: trace.keywords,
    hypothetical_answer: hypotheticalAnswerFromTrace(trace),
    resolved_refs: trace.resolved_refs,
    effective_kb_ids: options.effectiveKbIds,
    rewrite_model: config.rag.generation.model,
    created_at: nowRfc3339(),
  };
  await repo.saveQueryTrace(queryTrace);

  if (usage !== null) trace.usage = usage;
  await repo.saveAgentTrace(options.assistantMessageId, trace);

  const citationModels: Citation[] = citations.map((citation) => ({
    id: newUuid(),
    assistant_message_id: options.assistantMessageId,
    index: citation.index,
    chunk_id: citation.chunk_id,
    doc_id: citation.doc_id,
    doc_title: citation.doc_title,
    page_range: citation.page_range,
    heading_path: [],
    quote: citation.quote,
    score: citation.score,
    source_status: citation.source_status,
    anchor: citation.anchor ?? null,
  }));
  await repo.saveCitations(citationModels);

  // 缓存命中的答案没有管线检索轨迹，用引用回填证据链。
  const retrievalTraces = pipelineRetrievalTraces.length === 0
    ? citationRetrievalTraces(options.userMessageId, citations)
    : pipelineRetrievalTraces;
  await repo.saveRetrievalTraces(retrievalTraces);

  const session = await repo.getSession(actor.tenant_id, options.conversationId);
  if (session !== null) {
    session.updated_at = nowRfc3339();
    await repo.updateSession(session);
  }

  sendAnswerCompleted(ctx, options.assistantMessageId, confidence, usage);
}

/** 对应 Rust fail_assistant_message：先发失败事件，再把 answering 消息标记为 failed。 */
export async function failAssistantMessage(
  repo: ConversationRepository,
  tenantId: string,
  assistantMessageId: string,
  code: string,
  message: string,
  ctx: PipelineContext,
): Promise<void> {
  sendAnswerFailed(ctx, assistantMessageId, code, message);
  const failed = await repo.getMessage(tenantId, assistantMessageId);
  if (failed === null) throw AppError.messageNotFound();
  if (failed.status !== 'answering') return;
  failed.status = 'failed';
  failed.error_code = code;
  failed.error_message = message;
  failed.completed_at = nowRfc3339();
  await repo.updateMessage(failed);
}

async function assistantMessageCancelled(
  repo: ConversationRepository, tenantId: string, assistantMessageId: string,
): Promise<boolean> {
  const message = await repo.getMessage(tenantId, assistantMessageId);
  if (message === null) return false;
  return message.status === 'cancelled';
}

export function agentOptionsFromConfig(config: AppConfig): AgentOptions {
  return {
    mode: null,
    tone: config.agent.defaultTone,
    proactive_followup: config.agent.proactiveFollowup,
    max_followup_suggestions: config.agent.maxFollowupSuggestions,
    allow_analyst_mode: config.agent.allowAnalystMode,
    require_citation: config.rag.citation.requireCitation,
    generation: {
      model: config.rag.generation.model,
      temperature: config.rag.generation.temperature,
      max_output_tokens: config.rag.generation.maxOutputTokens,
    },
    retrieval: {
      dense_top_k: config.rag.retrieval.denseTopK,
      bm25_top_k: config.rag.retrieval.bm25TopK,
      rrf_top_k: config.rag.retrieval.rrfTopK,
      rerank_top_k: config.rag.retrieval.effectiveTopK,
      rerank_enabled: config.rag.rerank.enabled,
    },
    runtime: {
      hyde_enabled: config.rag.rewrite.hydeEnabled,
      max_react_steps: config.agent.maxReactSteps,
      max_queries_per_step: config.agent.maxQueriesPerStep,
      max_history_turns: config.agent.maxHistoryTurns,
      max_history_chars: config.agent.maxHistoryChars,
      max_context_chars: config.agent.maxContextChars,
      allow_verifier_correction: config.agent.maxRepairAttempts > 0,
    },
  };
}

export function citationRetrievalTraces(
  userMessageId: string, citations: CitationOutput[],
): RetrievalTrace[] {
  return citations.map((citation, index) => ({
    id: newUuid(),
    message_id: userMessageId,
    chunk_id: citation.chunk_id,
    doc_id: citation.doc_id,
    source: 'rerank',
    rank: index + 1,
    score: citation.score,
    heading_path: [],
    page_range: citation.page_range,
    content_preview: citation.quote,
  }));
}

/**
 * 用历史里已完成的问答对构造对话历史。重试/取消的助手消息不算完成，因此被排除。
 */
export async function buildHistory(
  sql: Sql | null,
  repo: ConversationRepository,
  tenantId: string,
  conversationId: string,
  excludeUserMessageId: string,
): Promise<ConversationTurn[]> {
  const messages = await repo.getMessages(tenantId, conversationId);
  const userMessages = new Map<string, ConversationMessage>();
  const assistantMessages = new Map<string, ConversationMessage>();
  for (const message of messages) {
    if (message.id === excludeUserMessageId) continue;
    if (message.role === 'user') userMessages.set(message.id, message);
    else assistantMessages.set(message.id, message);
  }

  const turns: ConversationTurn[] = [];
  const ordered = [...userMessages.values()]
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
  for (const userMessage of ordered) {
    const answer = [...assistantMessages.values()]
      .find((candidate) => candidate.parent_message_id === userMessage.id);
    if (answer === undefined) continue;
    if (answer.status !== 'completed' || answer.content.length === 0) continue;
    const rawCitations = await repo.getCitations(answer.id);
    const resolvedCitations: string[] = [];
    for (const citation of rawCitations) {
      if (citation.doc_title.trim() === '' || citation.doc_title === '未命名文档') {
        const resolved = await documentTitleForCitation(sql, tenantId, citation.doc_id);
        resolvedCitations.push(resolved ?? citation.doc_title);
      } else {
        resolvedCitations.push(citation.doc_title);
      }
    }
    turns.push({
      user_message: userMessage.content,
      assistant_answer: answer.content,
      citations: resolvedCitations,
    });
  }
  return turns;
}

/** 对齐 Rust `fetch_optional(...).await.ok().flatten()`：查不到或出错都返回 null。 */
async function documentTitleForCitation(
  sql: Sql | null, tenantId: string, docId: string,
): Promise<string | null> {
  if (sql === null) return null;
  try {
    const rows = await sql`SELECT title FROM documents WHERE tenant_id = ${tenantId} AND id = ${docId}`;
    const title = rows[0]?.title;
    return title === undefined || title === null ? null : String(title);
  } catch (error) {
    console.warn('[documind][conversations] document title lookup failed: ' + describeError(error));
    return null;
  }
}

function hypotheticalAnswerFromTrace(trace: AgentTrace): string | null {
  for (const step of trace.react_steps ?? []) {
    if (step.hypothetical_answer !== undefined && step.hypothetical_answer !== null) {
      return step.hypothetical_answer;
    }
  }
  return null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
