// 会话路由冒烟：用内存仓库校验 JSON 契约（不连数据库、不跑 LLM）
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { loadConfig } from '../config.ts';
import { AppError, toAppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import { nowRfc3339 } from '../infra/time.ts';
import { newUuid } from '../infra/uuid.ts';
import type { ConversationSession } from '../models/conversation.ts';
import type { CurrentActor } from '../models/identity.ts';
import type { ConversationMessage } from '../models/message.ts';
import { InMemoryConversationRepository } from '../repositories/memory.ts';
import type { AppState } from '../state.ts';
import { conversationsRouter } from './conversations.ts';

const KB_ID = '00000000-0000-0000-0000-0000000000aa';
const OTHER_KB_ID = '00000000-0000-0000-0000-0000000000bb';
const TENANT_ID = '00000000-0000-0000-0000-0000000000cc';
const USER_ID = '00000000-0000-0000-0000-0000000000dd';

function testActor(overrides: Partial<CurrentActor> = {}): CurrentActor {
  return {
    user_id: USER_ID, tenant_id: TENANT_ID, login_id: 'tester', email: 'tester@example.com',
    name: 'Tester', scope: 'tenant', roles: ['end_user'],
    permissions: ['chat.ask', 'answer.feedback'], allowed_kb_ids: [KB_ID],
    is_super_admin: false, api_client_id: null, api_token_id: null, api_scopes: [],
    api_token_expires_at: null,
    ...overrides,
  };
}

function testApp(repository: InMemoryConversationRepository, actor: CurrentActor): Hono<AppEnv> {
  const state = {
    config: loadConfig({}), sql: null, redis: null, repository,
    agentKernel: null, cache: null, storage: null, vectorConsistency: null, llm: null,
  } as unknown as AppState;
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('appState', state);
    c.set('actor', actor);
    await next();
  });
  app.route('/', conversationsRouter());
  app.onError((error, c) => {
    const appError = error instanceof AppError ? error : toAppError(error);
    return c.json(appError.toBody(), appError.httpStatus as 200);
  });
  return app;
}

function jsonRequest(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function message(
  id: string, conversationId: string, role: 'user' | 'assistant', overrides: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id, conversation_id: conversationId, tenant_id: TENANT_ID, user_id: USER_ID, role,
    content: role === 'user' ? '问题' : '答案', status: 'completed',
    parent_message_id: null, retry_of_message_id: null, client_request_id: null,
    confidence: null, no_answer_reason: null, error_code: null, error_message: null,
    agent_mode: null, prompt_versions: null,
    answer_source: 'rag', correction_id: null, correction_version_id: null,
    correction_match_type: null, correction_match_score: null,
    created_at: nowRfc3339(), completed_at: nowRfc3339(),
    ...overrides,
  };
}

async function seededConversation(repo: InMemoryConversationRepository): Promise<{
  conversationId: string; assistantMessageId: string;
}> {
  const conversationId = newUuid();
  const session: ConversationSession = {
    id: conversationId, tenant_id: TENANT_ID, user_id: USER_ID, title: '已存在的会话',
    kb_ids: [KB_ID], status: 'active', summary: null,
    created_at: nowRfc3339(), updated_at: nowRfc3339(),
  };
  await repo.createSession(session);
  const assistantMessageId = newUuid();
  await repo.createMessage(message(assistantMessageId, conversationId, 'assistant', {
    parent_message_id: newUuid(), content: '答案', confidence: 'high',
  }));
  return { conversationId, assistantMessageId };
}

describe('conversationsRouter', () => {
  test('会话生命周期：创建/列表/详情/改名/删除', async () => {
    const repo = new InMemoryConversationRepository();
    const app = testApp(repo, testActor({ allowed_kb_ids: [KB_ID, OTHER_KB_ID] }));

    const created = await app.request('/api/conversations', jsonRequest({
      kb_ids: [], title: '手动标题',
    }));
    expect(created.status).toBe(200);
    const createdBody = await created.json() as Record<string, any>;
    const conversationId = createdBody.conversation_id as string;
    expect(createdBody.title).toBe('手动标题');
    expect(createdBody.kb_ids).toEqual([KB_ID, OTHER_KB_ID]);
    expect(typeof createdBody.created_at).toBe('string');

    const listed = await app.request('/api/conversations');
    const listedBody = await listed.json() as {
      items: Array<Record<string, any>>; next_cursor: string | null;
    };
    expect(listedBody.next_cursor).toBeNull();
    expect(listedBody.items.length).toBe(1);
    expect(listedBody.items[0]!.conversation_id).toBe(conversationId);
    expect(listedBody.items[0]!.kb_ids).toEqual([KB_ID, OTHER_KB_ID]);
    expect(listedBody.items[0]!.last_message_preview).toBeNull();

    const detail = await app.request('/api/conversations/' + conversationId);
    const detailBody = await detail.json() as Record<string, any>;
    expect(detailBody.conversation_id).toBe(conversationId);
    expect(detailBody.title).toBe('手动标题');
    expect(detailBody.kb_ids).toEqual([KB_ID, OTHER_KB_ID]);
    expect(detailBody.status).toBe('active');
    expect(detailBody.summary).toBeNull();
    expect(detailBody.created_at).toBe(createdBody.created_at);
    expect(detailBody.updated_at).toBeString();

    const patched = await app.request(
      '/api/conversations/' + conversationId,
      jsonRequest({ title: ' 新标题 ', kb_ids: [KB_ID] }, 'PATCH'));
    expect(await patched.json()).toMatchObject({
      conversation_id: conversationId, title: '新标题', kb_ids: [KB_ID],
    });
    const updatedDetail = await app.request('/api/conversations/' + conversationId);
    expect((await updatedDetail.json() as Record<string, any>).kb_ids).toEqual([KB_ID]);

    const empty = await app.request(
      '/api/conversations/' + conversationId, jsonRequest({ title: '   ' }, 'PATCH'));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({
      code: 'EMPTY_CONVERSATION_TITLE', message: '会话标题不能为空',
    });

    const tooLong = await app.request(
      '/api/conversations/' + conversationId, jsonRequest({ title: 'x'.repeat(201) }, 'PATCH'));
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json() as Record<string, any>).code).toBe('CONVERSATION_TITLE_TOO_LONG');

    const deleted = await app.request(
      '/api/conversations/' + conversationId, { method: 'DELETE' });
    expect(await deleted.json()).toEqual({ conversation_id: conversationId, status: 'deleted' });
    const after = await app.request('/api/conversations');
    expect((await after.json() as { items: unknown[] }).items).toEqual([]);
  });

  test('kb 越权、缺失字段与非法路径参数的显式错误', async () => {
    const app = testApp(new InMemoryConversationRepository(), testActor());
    const denied = await app.request('/api/conversations', jsonRequest({ kb_ids: [OTHER_KB_ID] }));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      code: 'KB_SCOPE_DENIED', message: '请求知识库超出用户权限',
    });
    const mixed = await app.request(
      '/api/conversations', jsonRequest({ kb_ids: [KB_ID, OTHER_KB_ID] }));
    expect(mixed.status).toBe(403);
    const missing = await app.request('/api/conversations', jsonRequest({}));
    expect(missing.status).toBe(400);
    expect((await missing.json() as Record<string, any>).code).toBe('INVALID_REQUEST_BODY');
    const badPath = await app.request('/api/conversations/not-a-uuid');
    expect(badPath.status).toBe(400);
    expect(await badPath.json()).toEqual({
      code: 'INVALID_PATH_PARAM', message: '路径参数必须是 UUID',
    });
    const notFound = await app.request('/api/conversations/' + newUuid());
    expect(notFound.status).toBe(404);
    expect((await notFound.json() as Record<string, any>).code).toBe('CONVERSATION_NOT_FOUND');
  });

  test('消息请求不能越过会话保存的知识库范围', async () => {
    const repo = new InMemoryConversationRepository();
    const app = testApp(repo, testActor({ allowed_kb_ids: [KB_ID, OTHER_KB_ID] }));
    const conversationId = newUuid();
    await repo.createSession({
      id: conversationId, tenant_id: TENANT_ID, user_id: USER_ID, title: '单库会话',
      kb_ids: [KB_ID], status: 'active', summary: null,
      created_at: nowRfc3339(), updated_at: nowRfc3339(),
    });
    const response = await app.request(
      `/api/conversations/${conversationId}/messages`,
      jsonRequest({ content: '尝试跨库', kb_ids: [OTHER_KB_ID] }));
    expect({
      status: response.status,
      body: await response.json(),
    }).toEqual({
      status: 403,
      body: { code: 'KB_SCOPE_DENIED', message: '请求知识库超出用户权限' },
    });
  });

  test('权限不足与 API scope 不足', async () => {
    const noPermission = testApp(
      new InMemoryConversationRepository(), testActor({ permissions: [] }));
    const forbidden = await noPermission.request(
      '/api/conversations', jsonRequest({ kb_ids: [] }));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      code: 'FORBIDDEN', message: '当前身份无权执行该操作',
    });

    const noScope = testApp(new InMemoryConversationRepository(), testActor({
      api_client_id: 'client-1', api_token_id: 'token-1', api_scopes: [],
    }));
    const denied = await noScope.request('/api/conversations');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      code: 'API_SCOPE_DENIED', message: 'API Client 缺少 conversations:read 权限',
    });
  });

  test('消息列表带引用/推理步骤，无反馈时不出现 feedback 键', async () => {
    const repo = new InMemoryConversationRepository();
    const app = testApp(repo, testActor());
    const { conversationId, assistantMessageId } = await seededConversation(repo);
    const userMessageId = newUuid();
    await repo.createMessage(message(userMessageId, conversationId, 'user'));
    expect(assistantMessageId).toBeString();

    const response = await app.request(
      '/api/conversations/' + conversationId + '/messages');
    const body = await response.json() as {
      conversation_id: string; messages: Array<Record<string, any>>;
    };
    expect(body.conversation_id).toBe(conversationId);
    expect(body.messages.length).toBe(2);
    expect(body.messages[0]!.role).toBe('assistant');
    expect(body.messages[0]!.citations).toEqual([]);
    expect(body.messages[0]!.reasoning_steps).toEqual([]);
    expect('feedback' in body.messages[0]!).toBe(false);
    expect(body.messages[1]!.role).toBe('user');
    expect('feedback' in body.messages[1]!).toBe(false);
  });

  test('feedback 提交/回读/删除与非法 rating', async () => {
    const repo = new InMemoryConversationRepository();
    const app = testApp(repo, testActor());
    const { conversationId, assistantMessageId } = await seededConversation(repo);
    const feedbackPath =
      '/api/conversations/' + conversationId + '/messages/' + assistantMessageId + '/feedback';

    const submitted = await app.request(feedbackPath, jsonRequest({
      rating: 'up', reason: 'helpful', comment: '有用',
    }));
    expect(submitted.status).toBe(200);
    const submittedBody = await submitted.json() as Record<string, any>;
    expect(submittedBody.message_id).toBe(assistantMessageId);
    expect(submittedBody.rating).toBe('up');
    expect(submittedBody.reason).toBe('helpful');
    expect(submittedBody.comment).toBe('有用');
    expect(submittedBody.feedback_id).toBeString();

    const messages = await app.request('/api/conversations/' + conversationId + '/messages');
    const messagesBody = await messages.json() as { messages: Array<Record<string, any>> };
    expect(messagesBody.messages[0]!.feedback.feedback_id).toBe(submittedBody.feedback_id);

    const invalid = await app.request(feedbackPath, jsonRequest({ rating: 'meh' }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as Record<string, any>).code).toBe('INVALID_REQUEST_BODY');

    const removed = await app.request(feedbackPath, { method: 'DELETE' });
    expect(await removed.json()).toEqual({ message_id: assistantMessageId });
  });

  test('traces 端点返回三类轨迹，跨会话消息 404', async () => {
    const repo = new InMemoryConversationRepository();
    const app = testApp(repo, testActor());
    const { conversationId, assistantMessageId } = await seededConversation(repo);
    const traces = await app.request(
      '/api/conversations/' + conversationId + '/messages/' + assistantMessageId + '/traces');
    expect(await traces.json()).toEqual({
      message_id: assistantMessageId, agent_trace: null, query_trace: null, retrieval_traces: [],
    });
    const other = await seededConversation(repo);
    const mismatched = await app.request(
      '/api/conversations/' + conversationId + '/messages/' + other.assistantMessageId + '/traces');
    expect(mismatched.status).toBe(404);
    expect((await mismatched.json() as Record<string, any>).code).toBe('MESSAGE_NOT_FOUND');
  });
});
