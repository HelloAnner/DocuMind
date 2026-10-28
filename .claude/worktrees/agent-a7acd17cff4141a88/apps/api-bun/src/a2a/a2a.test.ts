// A2A 契约测试：AgentCard 形状、未关联账号 409、内核事件 -> A2A 帧映射。
import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { SSEStreamingApi, SSEMessage } from 'hono/streaming';
import type { Sql } from 'postgres';
import type { AppEnv } from '../http/types.ts';
import type { AppState } from '../state.ts';
import { RuntimeEventFactory } from '../api/runtime_events.ts';
import {
  sendAnswerCompleted, sendAnswerFailed, sendAnswerDelta, sendCitationDelta,
  sendExecutionStarted, sendProgressEvent, type PipelineContext,
} from '../api/conversations_sse.ts';
import { A2ASink, appendableSuffix } from './sink.ts';
import { a2aRouter, buildAgentCard, normalizeQuestion } from './mod.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('agent-card', () => {
  test('字段与 Portal A2A 契约一致', () => {
    const card = buildAgentCard('https://documind.example.com/documind/');
    expect(card.name).toBe('Documind 文档 Agent');
    expect(card.url).toBe('https://documind.example.com/documind/a2a');
    expect(card.version).toBe('1.0.0');
    expect(card.capabilities).toEqual({ streaming: true });
    expect(card.defaultInputModes).toEqual(['text']);
    expect(card.defaultOutputModes).toEqual(['text']);
    expect(card.securitySchemes).toEqual({ portal: { type: 'http', scheme: 'bearer' } });
    expect(card.security).toEqual([{ portal: [] }]);
    expect(card.skills.length).toBeGreaterThanOrEqual(1);
    expect(card.skills[0]!.id).toBeString();
    expect(card.skills[0]!.examples.length).toBeGreaterThan(0);
  });

  test('GET /.well-known/agent-card.json 返回 200 JSON', async () => {
    const app = miniApp();
    const response = await app.request('/.well-known/agent-card.json');
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.name).toBe('Documind 文档 Agent');
    expect((body.capabilities as { streaming?: boolean }).streaming).toBe(true);
  });
});

describe('身份未关联', () => {
  test('返回 409 + JSON-RPC error(account_not_linked, link_url)', async () => {
    const future = Math.floor(Date.now() / 1000) + 30;
    globalThis.fetch = (async () => Response.json({
      user_id: '11111111-1111-4111-8111-111111111111',
      username: 'anner', display_name: 'Anner', email: 'anner@corp.cn',
      tenant_id: '22222222-2222-4222-8222-222222222222',
      tenant_code: 'corp', tenant_name: 'Corp',
      system_code: 'documind', portal_roles: ['user'], system_roles: ['user'],
      permissions: ['documind:chat:ask'], expires_at: future,
    })) as unknown as typeof fetch;

    const app = miniApp();
    const response = await app.request('/a2a', {
      method: 'POST',
      headers: {
        authorization: 'Bearer 33333333-3333-4333-8333-333333333333:secret-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'rpc-9', method: 'message/stream',
        params: { message: { role: 'user', messageId: 'm-1', contextId: 'ctx-9',
          parts: [{ kind: 'text', text: '@Documind 差旅报销标准' }] } },
      }),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as Record<string, any>;
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe('rpc-9');
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe('门户账号尚未关联');
    expect(body.error.data.reason).toBe('account_not_linked');
    expect(body.error.data.link_url)
      .toBe('https://portal.example.com/api/portal/systems/documind/enter');
  });

  test('缺少票据返回 401 JSON-RPC error', async () => {
    const app = miniApp();
    const response = await app.request('/a2a', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/stream',
        params: { message: { role: 'user', parts: [{ kind: 'text', text: '问题' }] } } }),
    });
    expect(response.status).toBe(401);
    const body = await response.json() as Record<string, any>;
    expect(body.error.data.reason).toBe('missing_ticket');
  });
});

describe('A2A sink 事件映射', () => {
  test('execution -> task/status，delta -> artifact-update，来源+完成', async () => {
    const { ctx, frames, sink } = recordingContext();
    sendExecutionStarted(ctx, 'user-msg-1', 'msg-1', '问题');
    sendProgressEvent(ctx, 'msg-1', { type: 'response_delta', delta: '第一段' });
    sendAnswerDelta(ctx, 'msg-1', '第二段');
    sendProgressEvent(ctx, 'msg-1', { type: 'status_updated', status: 'retrieving' });
    sendCitationDelta(ctx, 'msg-1', citation);
    sendAnswerCompleted(ctx, 'msg-1', 'high', null);
    await sink.flush();

    expect(frames.map((frame) => frame.event)).toEqual([
      'task', 'status-update', 'artifact-update', 'artifact-update', 'status-update',
      'artifact-update', 'status-update',
    ]);

    const task = payload(frames[0]!);
    expect(task.jsonrpc).toBe('2.0');
    expect(task.id).toBe('rpc-1');
    expect(task.result).toEqual({
      kind: 'task', id: 'task-1', contextId: 'ctx-1', status: { state: 'submitted' },
    });

    const working = payload(frames[1]!);
    expect(working.result.kind).toBe('status-update');
    expect(working.result.taskId).toBe('task-1');
    expect(working.result.contextId).toBe('ctx-1');
    expect(working.result.final).toBe(false);
    expect(working.result.status.state).toBe('working');

    const first = payload(frames[2]!);
    expect(first.result.artifact.parts).toEqual([{ kind: 'text', text: '第一段' }]);
    expect(first.result.append).toBe(true);
    expect(first.result.artifact.artifactId).toBe('answer');

    const stage = payload(frames[4]!);
    expect(stage.result.status.message).toBe('正在检索文档');

    const sources = payload(frames[5]!);
    expect(sources.result.artifact.artifactId).toBe('sources');
    expect(sources.result.artifact.metadata.sources).toEqual([
      expect.objectContaining({ title: '手册.pdf', section: '第 1-2 页' }),
    ]);

    const completed = payload(frames[6]!);
    expect(completed.result).toEqual({
      kind: 'status-update', taskId: 'task-1', contextId: 'ctx-1',
      final: true, status: { state: 'completed' },
    });
  });

  test('失败事件映射为 event: error 帧并终止', async () => {
    const { ctx, frames, sink } = recordingContext();
    sendExecutionStarted(ctx, 'user-msg-1', 'msg-1', '问题');
    sendAnswerFailed(ctx, 'msg-1', 'PIPELINE_ERROR', '执行失败');
    sendAnswerDelta(ctx, 'msg-1', '不应出现');
    await sink.flush();

    expect(frames.map((frame) => frame.event)).toEqual(['task', 'status-update', 'error']);
    const error = payload(frames[2]!);
    expect(error.error.code).toBe(-32000);
    expect(error.error.message).toBe('执行失败');
    expect(error.error.data.reason).toBe('pipeline_error');
  });

  test('thinking.delta / tool.call.* 不产生 A2A 帧', async () => {
    const { ctx, frames, sink } = recordingContext();
    sendProgressEvent(ctx, 'msg-1', { type: 'thinking_delta', delta: '想' });
    sendProgressEvent(ctx, 'msg-1', {
      type: 'tool_call_started', tool_call_id: 'c1', name: 'knowledge_search', arguments: {},
    });
    await sink.flush();
    expect(frames).toEqual([]);
  });
});

describe('纯函数', () => {
  test('appendableSuffix 支持前缀增量与重置', () => {
    expect(appendableSuffix('', 'abc')).toBe('abc');
    expect(appendableSuffix('ab', 'abc')).toBe('c');
    expect(appendableSuffix('abc', 'abc')).toBe('');
    expect(appendableSuffix('abcd', 'abef')).toBe('ef');
  });

  test('normalizeQuestion 去掉开头 @Handle，纯 @ 时保留原文', () => {
    expect(normalizeQuestion('@Documind 差旅报销标准')).toBe('差旅报销标准');
    expect(normalizeQuestion('@Northline 查一下')).toBe('查一下');
    expect(normalizeQuestion('@Documind')).toBe('@Documind');
    expect(normalizeQuestion('普通问题')).toBe('普通问题');
  });
});

const citation = {
  citation_id: 'citation-1', index: 1, chunk_id: 'chunk-1', doc_id: 'doc-1',
  doc_title: '手册.pdf', page_range: [1, 2], quote: '引用片段', score: 0.9,
  source_status: 'available',
};

interface RecordedFrame { event: string; data: string; }

function recordingContext(): {
  ctx: PipelineContext; frames: RecordedFrame[]; sink: A2ASink;
} {
  const frames: RecordedFrame[] = [];
  const stream = {
    writeSSE: async (message: SSEMessage) => { frames.push(message as RecordedFrame); },
  } as unknown as SSEStreamingApi;
  const sink = new A2ASink(stream, { rpcId: 'rpc-1', taskId: 'task-1', contextId: 'ctx-1' });
  const factory = new RuntimeEventFactory('tenant-1', 'user-1', 'conv-1', 'msg-1');
  return { ctx: { sink, protocol: 'atom', factory, abandoned: false }, frames, sink };
}

function payload(frame: RecordedFrame): Record<string, any> {
  return JSON.parse(frame.data) as Record<string, any>;
}

/** 用桩 state 装配最小 app：只需 appState.config / appState.sql。 */
function miniApp(): Hono<AppEnv> {
  const sql = (() => Promise.resolve([])) as unknown as Sql;
  const state = {
    config: {
      portalBaseUrl: 'https://portal.example.com',
      portalExchangeEndpoint: '/api/auth/exchange-ticket',
    },
    sql,
  } as unknown as AppState;
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('appState', state); await next(); });
  app.route('/', a2aRouter());
  return app;
}
