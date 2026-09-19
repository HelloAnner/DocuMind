// 契约测试：Legacy/Atom 双协议的事件名与负载必须与 Rust 逐一对应
import { describe, expect, test } from 'bun:test';
import type { SSEStreamingApi, SSEMessage } from 'hono/streaming';
import { RuntimeEventFactory } from './runtime_events.ts';
import {
  SseSink, sendAnswerCompleted, sendAnswerDelta, sendAnswerFailed, sendCitationDelta,
  sendConversationTitleUpdated, sendExecutionCancelled, sendExecutionStarted,
  sendProgressEvent, type PipelineContext,
} from './conversations_sse.ts';

interface RecordedEvent { event?: string; id?: string; data: string; }

function recordingContext(protocol: 'legacy' | 'atom'): {
  ctx: PipelineContext; events: RecordedEvent[];
} {
  const events: RecordedEvent[] = [];
  const stream = {
    writeSSE: async (message: SSEMessage) => { events.push(message as RecordedEvent); },
  } as unknown as SSEStreamingApi;
  const factory = new RuntimeEventFactory('tenant-1', 'user-1', 'conversation-1', 'assistant-1');
  return { ctx: { sink: new SseSink(stream), protocol, factory, abandoned: false }, events };
}

const citation = {
  citation_id: 'citation-1', index: 1, chunk_id: 'chunk-1', doc_id: 'doc-1',
  doc_title: '手册.pdf', page_range: [1, 2], quote: '引用片段', score: 0.9,
  source_status: 'available',
};

describe('legacy 协议', () => {
  test('message.created 与逐段回答事件', async () => {
    const { ctx, events } = recordingContext('legacy');
    sendExecutionStarted(ctx, 'user-message-1', 'assistant-1', '问题');
    sendAnswerDelta(ctx, 'assistant-1', '片段');
    sendCitationDelta(ctx, 'assistant-1', citation);
    sendAnswerCompleted(ctx, 'assistant-1', 'high', { input_tokens: 10, output_tokens: 4 });
    sendConversationTitleUpdated(ctx, 'conversation-1', '新标题');
    await ctx.sink.flush();
    expect(events.map((event) => event.event)).toEqual([
      'message.created', 'answer.delta', 'citation.delta', 'answer.completed',
      'conversation.title.updated',
    ]);
    expect(events.every((event) => event.id === undefined)).toBe(true);
    expect(JSON.parse(events[0]!.data)).toEqual({
      user_message_id: 'user-message-1', assistant_message_id: 'assistant-1',
    });
    expect(JSON.parse(events[1]!.data)).toEqual({ message_id: 'assistant-1', text: '片段' });
    expect(JSON.parse(events[2]!.data)).toEqual({
      message_id: 'assistant-1', citation: citation,
    });
    expect(JSON.parse(events[3]!.data)).toEqual({
      message_id: 'assistant-1', confidence: 'high',
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    expect(JSON.parse(events[4]!.data)).toEqual({
      conversation_id: 'conversation-1', title: '新标题',
    });
  });

  test('进度事件映射，工具调用不进 legacy 流，flush 立即 ack', async () => {
    const { ctx, events } = recordingContext('legacy');
    sendProgressEvent(ctx, 'assistant-1', { type: 'status_updated', status: 'generating' });
    sendProgressEvent(ctx, 'assistant-1', {
      type: 'rewrite_completed', rewritten_query: '重写问题', keywords: ['关键词'],
    });
    sendProgressEvent(ctx, 'assistant-1', {
      type: 'tool_call_started', tool_call_id: 'call-1', name: 'knowledge_search', arguments: {},
    });
    let acknowledged = false;
    sendProgressEvent(ctx, 'assistant-1', {
      type: 'flush', acknowledgement: () => { acknowledged = true; },
    });
    await ctx.sink.flush();
    expect(acknowledged).toBe(true);
    expect(events.map((event) => event.event)).toEqual(['status.updated', 'rewrite.completed']);
    expect(JSON.parse(events[0]!.data)).toEqual({
      message_id: 'assistant-1', status: 'generating',
    });
    expect(JSON.parse(events[1]!.data)).toEqual({
      message_id: 'assistant-1', rewritten_query: '重写问题', keywords: ['关键词'],
    });
  });

  test('answer.failed 带 code/message，取消事件不发出', async () => {
    const { ctx, events } = recordingContext('legacy');
    sendExecutionCancelled(ctx);
    sendAnswerFailed(ctx, 'assistant-1', 'PIPELINE_TIMEOUT', '超时');
    await ctx.sink.flush();
    expect(events.map((event) => event.event)).toEqual(['answer.failed']);
    expect(JSON.parse(events[0]!.data)).toEqual({
      message_id: 'assistant-1', code: 'PIPELINE_TIMEOUT', message: '超时',
    });
  });
});

describe('atom 协议', () => {
  test('信封字段与 execution.started 负载', async () => {
    const { ctx, events } = recordingContext('atom');
    sendExecutionStarted(ctx, 'user-message-1', 'assistant-1', '问题');
    await ctx.sink.flush();
    const event = events[0]!;
    expect(event.event).toBe('execution.started');
    expect(event.id).toBeString();
    const envelope = JSON.parse(event.data) as Record<string, unknown>;
    expect(envelope.schema_version).toBe('moss.execution.event.v1');
    expect(envelope.event_type).toBe('execution.started');
    expect(envelope.event_seq).toBe(1);
    expect(envelope.tenant_id).toBe('tenant-1');
    expect(envelope.user_id).toBe('user-1');
    expect(envelope.session_id).toBe('conversation-1');
    expect(envelope.response_message_id).toBe('assistant-1');
    expect(envelope.step).toBeNull();
    expect(envelope.payload).toEqual({
      task: '问题', plan_mode: false,
      user_message_id: 'user-message-1', assistant_message_id: 'assistant-1',
    });
  });

  test('进度事件含 response.stage / response.delta / tool.call.started 步骤', async () => {
    const { ctx, events } = recordingContext('atom');
    sendProgressEvent(ctx, 'assistant-1', { type: 'response_delta', delta: '文字' });
    sendProgressEvent(ctx, 'assistant-1', {
      type: 'tool_call_started', tool_call_id: 'call-1', name: 'knowledge_search',
      arguments: { query: 'q' },
    });
    await ctx.sink.flush();
    expect(events.map((event) => event.event)).toEqual(['response.delta', 'tool.call.started']);
    const delta = JSON.parse(events[0]!.data) as Record<string, any>;
    expect(delta.event_type).toBe('response.delta');
    expect(delta.payload).toEqual({ delta: '文字' });
    const tool = JSON.parse(events[1]!.data) as Record<string, any>;
    expect(tool.payload.name).toBe('knowledge_search');
    expect(tool.step).toEqual({
      step_id: 'call-1', parent_step_id: null, step_type: 'ToolCall', name: 'knowledge_search',
    });
  });

  test('来源上报与执行收尾事件', async () => {
    const { ctx, events } = recordingContext('atom');
    sendCitationDelta(ctx, 'assistant-1', citation);
    sendAnswerCompleted(ctx, 'assistant-1', 'medium', { input_tokens: 3, output_tokens: 7 });
    sendConversationTitleUpdated(ctx, 'conversation-1', '标题');
    sendAnswerFailed(ctx, 'assistant-1', 'PIPELINE_ERROR', '失败');
    sendExecutionCancelled(ctx);
    await ctx.sink.flush();
    expect(events.map((event) => event.event)).toEqual([
      'sources.reported', 'response.completed', 'usage.reported', 'execution.completed',
      'conversation.title.updated', 'execution.failed', 'execution.cancelled',
    ]);
    const sources = JSON.parse(events[0]!.data) as Record<string, any>;
    expect(sources.payload.sources).toEqual([{
      title: '手册.pdf', uri: 'doc-1', documind_citation: citation,
    }]);
    const completed = JSON.parse(events[1]!.data) as Record<string, any>;
    expect(completed.payload).toEqual({ finish_reason: 'stop', confidence: 'medium' });
    const usage = JSON.parse(events[2]!.data) as Record<string, any>;
    expect(usage.payload).toEqual({
      prompt_tokens: 3, completion_tokens: 7, total_tokens: 10,
    });
    const failed = JSON.parse(events[5]!.data) as Record<string, any>;
    expect(failed.payload).toEqual({
      error: { code: 'PIPELINE_ERROR', message: '失败', source: 'agent', recoverable: true },
    });
    const cancelled = JSON.parse(events[6]!.data) as Record<string, any>;
    expect(cancelled.payload).toEqual({});
  });

  test('abandoned 后事件被丢弃', async () => {
    const { ctx, events } = recordingContext('atom');
    ctx.abandoned = true;
    sendExecutionStarted(ctx, 'user-message-1', 'assistant-1', '问题');
    sendAnswerDelta(ctx, 'assistant-1', '不该出现');
    await ctx.sink.flush();
    expect(events).toEqual([]);
  });
});
