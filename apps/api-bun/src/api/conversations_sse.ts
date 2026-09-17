// 移植自 apps/api-rs/src/api/conversations.rs 的 SSE 事件层（Legacy + Atom 双协议）
import type { SSEStreamingApi } from 'hono/streaming';
import type { AgentProgress } from '../agent/events.ts';
import type { CitationOutput } from '../models/agent.ts';
import type { Confidence, Usage } from '../models/index.ts';
import type { RuntimeEventFactory, RuntimeStep, SseEvent, SseProtocol } from './runtime_events.ts';
import { toolStep } from './runtime_events.ts';

/** Legacy 协议事件：没有 SSE id 行。 */
export interface PlainSseEvent { event: string; data: string; }
export type OutboundSseEvent = PlainSseEvent | SseEvent;

/**
 * SSE 输出端口。Rust 用 tokio mpsc::UnboundedSender，发送永不阻塞管线；
 * 这里用一条串行 promise 链保证事件顺序，写失败只记日志（对齐 Rust 的 let _ = tx.send）。
 */
export class SseSink {
  private chain: Promise<void> = Promise.resolve();
  private broken = false;

  constructor(private readonly stream: SSEStreamingApi) {}

  send(event: OutboundSseEvent): void {
    if (this.broken) return;
    const message = 'id' in event
      ? { event: event.event, data: event.data, id: event.id }
      : { event: event.event, data: event.data };
    this.chain = this.chain
      .then(() => this.stream.writeSSE(message))
      .catch((error: unknown) => {
        this.broken = true;
        console.warn('[documind][conversations] SSE write failed: ' + (error as Error).message);
      });
  }

  /** 等待已入队事件写盘（关闭流之前调用）。 */
  flush(): Promise<void> { return this.chain; }
}

export interface PipelineContext {
  sink: SseSink;
  protocol: SseProtocol;
  factory: RuntimeEventFactory;
  /** 管线被超时放弃后置 true，丢弃其残留事件（等价于 Rust drop 掉 future）。 */
  abandoned: boolean;
}

export type LegacyEvent =
  | { kind: 'message_created'; user_message_id: string; assistant_message_id: string }
  | { kind: 'status_updated'; message_id: string; status: string }
  | { kind: 'rewrite_completed'; message_id: string; rewritten_query: string; keywords: string[] }
  | { kind: 'retrieval_completed'; message_id: string; chunk_count: number; warnings: string[] }
  | { kind: 'rerank_completed'; message_id: string; top_chunk_ids: string[] }
  | { kind: 'answer_delta'; message_id: string; text: string }
  | { kind: 'citation_delta'; message_id: string; citation: CitationOutput }
  | { kind: 'answer_completed'; message_id: string; confidence: Confidence; usage: Usage | null }
  | { kind: 'answer_failed'; message_id: string; code: string; message: string }
  | { kind: 'conversation_title_updated'; conversation_id: string; title: string };

function legacyEventName(event: LegacyEvent): string {
  switch (event.kind) {
    case 'message_created': return 'message.created';
    case 'status_updated': return 'status.updated';
    case 'rewrite_completed': return 'rewrite.completed';
    case 'retrieval_completed': return 'retrieval.completed';
    case 'rerank_completed': return 'rerank.completed';
    case 'answer_delta': return 'answer.delta';
    case 'citation_delta': return 'citation.delta';
    case 'answer_completed': return 'answer.completed';
    case 'answer_failed': return 'answer.failed';
    case 'conversation_title_updated': return 'conversation.title.updated';
  }
}

function legacyEventData(event: LegacyEvent): unknown {
  switch (event.kind) {
    case 'message_created':
      return {
        user_message_id: event.user_message_id,
        assistant_message_id: event.assistant_message_id,
      };
    case 'status_updated':
      return { message_id: event.message_id, status: event.status };
    case 'rewrite_completed':
      return {
        message_id: event.message_id,
        rewritten_query: event.rewritten_query,
        keywords: event.keywords,
      };
    case 'retrieval_completed':
      return {
        message_id: event.message_id,
        chunk_count: event.chunk_count,
        warnings: event.warnings,
      };
    case 'rerank_completed':
      return { message_id: event.message_id, top_chunk_ids: event.top_chunk_ids };
    case 'answer_delta':
      return { message_id: event.message_id, text: event.text };
    case 'citation_delta':
      return { message_id: event.message_id, citation: event.citation };
    case 'answer_completed':
      return { message_id: event.message_id, confidence: event.confidence, usage: event.usage };
    case 'answer_failed':
      return { message_id: event.message_id, code: event.code, message: event.message };
    case 'conversation_title_updated':
      return { conversation_id: event.conversation_id, title: event.title };
  }
}

function sendLegacyEvent(ctx: PipelineContext, event: LegacyEvent): void {
  if (ctx.abandoned) return;
  ctx.sink.send({ event: legacyEventName(event), data: JSON.stringify(legacyEventData(event)) });
}

function emitAtom(
  ctx: PipelineContext, eventType: string, step: RuntimeStep | null, payload: unknown,
): void {
  if (ctx.abandoned) return;
  const event = step === null
    ? ctx.factory.event(eventType, payload)
    : ctx.factory.eventWithStep(eventType, step, payload);
  ctx.sink.send(event);
}

export function sendRuntimeEvent(ctx: PipelineContext, eventType: string, payload: unknown): void {
  emitAtom(ctx, eventType, null, payload);
}

export function sendRuntimeStepEvent(
  ctx: PipelineContext, eventType: string, toolCallId: string, name: string, payload: unknown,
): void {
  emitAtom(ctx, eventType, toolStep(toolCallId, name), payload);
}

export function sendExecutionStarted(
  ctx: PipelineContext, userMessageId: string, assistantMessageId: string, task: string,
): void {
  if (ctx.protocol === 'legacy') {
    sendLegacyEvent(ctx, {
      kind: 'message_created',
      user_message_id: userMessageId,
      assistant_message_id: assistantMessageId,
    });
    return;
  }
  sendRuntimeEvent(ctx, 'execution.started', {
    task: task,
    plan_mode: false,
    user_message_id: userMessageId,
    assistant_message_id: assistantMessageId,
  });
}

export function progressToLegacyEvent(
  messageId: string, progress: AgentProgress,
): LegacyEvent | null {
  switch (progress.type) {
    case 'status_updated':
      return { kind: 'status_updated', message_id: messageId, status: progress.status };
    case 'rewrite_completed':
      return {
        kind: 'rewrite_completed',
        message_id: messageId,
        rewritten_query: progress.rewritten_query,
        keywords: progress.keywords,
      };
    case 'retrieval_completed':
      return {
        kind: 'retrieval_completed',
        message_id: messageId,
        chunk_count: progress.chunk_count,
        warnings: progress.warnings,
      };
    case 'rerank_completed':
      return {
        kind: 'rerank_completed',
        message_id: messageId,
        top_chunk_ids: progress.top_chunk_ids,
      };
    case 'react_step_started':
    case 'tool_call_started':
    case 'tool_call_completed':
    case 'tool_call_failed':
    case 'response_delta':
    case 'response_reset':
    case 'thinking_delta':
      return null;
    case 'flush':
      progress.acknowledgement();
      return null;
  }
}

export function sendProgressEvent(
  ctx: PipelineContext, messageId: string, progress: AgentProgress,
): void {
  if (progress.type === 'flush') {
    progress.acknowledgement();
    return;
  }
  if (ctx.protocol === 'legacy') {
    const event = progressToLegacyEvent(messageId, progress);
    if (event !== null) sendLegacyEvent(ctx, event);
    return;
  }

  switch (progress.type) {
    case 'status_updated':
      sendRuntimeEvent(ctx, 'response.stage', { stage: progress.status });
      break;
    case 'rewrite_completed':
      sendRuntimeEvent(ctx, 'agent.query_understood', {
        standalone_query: progress.rewritten_query,
        keywords: progress.keywords,
      });
      break;
    case 'react_step_started':
      sendRuntimeEvent(ctx, 'agent.step.started', {
        step: progress.step,
        action: progress.action,
        decision_summary: progress.decision_summary,
      });
      break;
    case 'tool_call_started':
      sendRuntimeStepEvent(ctx, 'tool.call.started', progress.tool_call_id, progress.name, {
        tool_call_id: progress.tool_call_id,
        name: progress.name,
        arguments: progress.arguments,
      });
      break;
    case 'tool_call_completed':
      sendRuntimeStepEvent(ctx, 'tool.call.result', progress.tool_call_id, progress.name, {
        tool_call_id: progress.tool_call_id,
        name: progress.name,
        status: 'succeeded',
        result: progress.result,
      });
      break;
    case 'tool_call_failed':
      sendRuntimeStepEvent(ctx, 'tool.call.failed', progress.tool_call_id, progress.name, {
        tool_call_id: progress.tool_call_id,
        name: progress.name,
        status: 'failed',
        error: progress.error,
      });
      break;
    case 'retrieval_completed':
      sendRuntimeEvent(ctx, 'retrieval.completed', {
        chunk_count: progress.chunk_count,
        warnings: progress.warnings,
      });
      break;
    case 'rerank_completed':
      sendRuntimeEvent(ctx, 'rerank.completed', { top_chunk_ids: progress.top_chunk_ids });
      break;
    case 'response_delta':
      sendRuntimeEvent(ctx, 'response.delta', { delta: progress.delta });
      break;
    case 'response_reset':
      sendRuntimeEvent(ctx, 'response.replace', { content: '' });
      break;
    case 'thinking_delta':
      sendRuntimeEvent(ctx, 'thinking.delta', { delta: progress.delta });
      break;
    case 'flush':
      break;
  }
}

export function sendAnswerDelta(ctx: PipelineContext, messageId: string, text: string): void {
  if (ctx.protocol === 'legacy') {
    sendLegacyEvent(ctx, { kind: 'answer_delta', message_id: messageId, text: text });
    return;
  }
  sendRuntimeEvent(ctx, 'response.delta', { delta: text });
}

export function sendAnswerReplace(ctx: PipelineContext, messageId: string, text: string): void {
  if (ctx.protocol === 'legacy') {
    sendLegacyEvent(ctx, { kind: 'answer_delta', message_id: messageId, text: text });
    return;
  }
  sendRuntimeEvent(ctx, 'response.replace', { content: text });
}

export function sendCitationDelta(
  ctx: PipelineContext, messageId: string, citation: CitationOutput,
): void {
  if (ctx.protocol === 'legacy') {
    sendLegacyEvent(ctx, { kind: 'citation_delta', message_id: messageId, citation: citation });
    return;
  }
  sendRuntimeEvent(ctx, 'sources.reported', {
    sources: [{
      title: citation.doc_title,
      uri: citation.doc_id,
      documind_citation: citation,
    }],
  });
}

export function sendAnswerCompleted(
  ctx: PipelineContext, messageId: string, confidence: Confidence, usage: Usage | null,
): void {
  if (ctx.protocol === 'legacy') {
    sendLegacyEvent(ctx, {
      kind: 'answer_completed',
      message_id: messageId,
      confidence: confidence,
      usage: usage,
    });
    return;
  }
  sendRuntimeEvent(ctx, 'response.completed', { finish_reason: 'stop', confidence: confidence });
  if (usage !== null) {
    sendRuntimeEvent(ctx, 'usage.reported', {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.input_tokens + usage.output_tokens,
    });
  }
  sendRuntimeEvent(ctx, 'execution.completed', { summary: '执行成功' });
}

export function sendAnswerFailed(
  ctx: PipelineContext, messageId: string, code: string, message: string,
): void {
  if (ctx.protocol === 'legacy') {
    sendLegacyEvent(ctx, {
      kind: 'answer_failed',
      message_id: messageId,
      code: code,
      message: message,
    });
    return;
  }
  sendRuntimeEvent(ctx, 'execution.failed', {
    error: { code: code, message: message, source: 'agent', recoverable: true },
  });
}

export function sendExecutionCancelled(ctx: PipelineContext): void {
  if (ctx.protocol === 'atom') {
    sendRuntimeEvent(ctx, 'execution.cancelled', {});
  }
}

export function sendConversationTitleUpdated(
  ctx: PipelineContext, conversationId: string, title: string,
): void {
  if (ctx.protocol === 'legacy') {
    sendLegacyEvent(ctx, {
      kind: 'conversation_title_updated',
      conversation_id: conversationId,
      title: title,
    });
    return;
  }
  sendRuntimeEvent(ctx, 'conversation.title.updated', {
    conversation_id: conversationId,
    title: title,
  });
}
