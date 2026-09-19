import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { loadConfig } from './config.ts';
import type { AppEnv } from './http/types.ts';
import type { CurrentActor } from './models/identity.ts';
import { InMemoryConversationRepository } from './repositories/memory.ts';
import type { AppState } from './state.ts';
import { buildDocumindMcpServer, createDocumindMcpEndpoint } from './mcp.ts';

const actor: CurrentActor = {
  user_id: '00000000-0000-4000-8000-000000000001',
  tenant_id: '00000000-0000-4000-8000-000000000002',
  login_id: 'mcp@test',
  email: 'mcp@test',
  name: 'MCP test',
  scope: 'tenant',
  roles: ['end_user'],
  permissions: ['chat.ask'],
  allowed_kb_ids: ['00000000-0000-4000-8000-000000000003'],
  is_super_admin: false,
  api_client_id: '00000000-0000-4000-8000-000000000004',
  api_token_id: '00000000-0000-4000-8000-000000000005',
  api_scopes: ['chat:write', 'conversations:read', 'conversations:write'],
  api_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
};
const state = {
  config: loadConfig({}),
  sql: null,
  redis: null,
  repository: new InMemoryConversationRepository(),
  agentKernel: null,
  cache: null,
  storage: null,
  vectorConsistency: null,
  llm: null,
} as unknown as AppState;

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'documind-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function protocolCall(method: string, params: Record<string, unknown>) {
  const handler = createMcpHandler(() => buildDocumindMcpServer(state, actor));
  const request = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(method === 'tools/call' ? { 'Mcp-Name': String(params.name) } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method, params: { ...params, _meta: meta },
    }),
  });
  const response = await handler.fetch(request, { parsedBody: await request.clone().json() });
  const text = await response.text();
  return response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find((line) => line.startsWith('data:'))!.slice(5))
    : JSON.parse(text);
}

describe('DocuMind MCP', () => {
  test('rejects requests without a tenant token', async () => {
    const app = new Hono<AppEnv>();
    app.post('/mcp', createDocumindMcpEndpoint(state));
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  test('lists only tools granted to the token scopes', async () => {
    const payload = await protocolCall('tools/list', {});
    expect(payload.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'documind_chat',
      'documind_conversation_list',
      'documind_conversation_get',
      'documind_conversation_rename',
      'documind_conversation_delete',
    ]);
  });

  test('conversation tools cannot cross tenant or service identity boundaries', async () => {
    const timestamp = new Date().toISOString();
    await state.repository.createSession({
      id: '10000000-0000-4000-8000-000000000001',
      tenant_id: actor.tenant_id,
      user_id: actor.user_id,
      title: 'owned',
      kb_ids: [],
      status: 'active',
      summary: null,
      created_at: timestamp,
      updated_at: timestamp,
    });
    await state.repository.createSession({
      id: '10000000-0000-4000-8000-000000000002',
      tenant_id: actor.tenant_id,
      user_id: '10000000-0000-4000-8000-000000000099',
      title: 'other identity',
      kb_ids: [],
      status: 'active',
      summary: null,
      created_at: timestamp,
      updated_at: timestamp,
    });
    await state.repository.createSession({
      id: '10000000-0000-4000-8000-000000000003',
      tenant_id: '10000000-0000-4000-8000-000000000098',
      user_id: actor.user_id,
      title: 'other tenant',
      kb_ids: [],
      status: 'active',
      summary: null,
      created_at: timestamp,
      updated_at: timestamp,
    });

    const payload = await protocolCall('tools/call', {
      name: 'documind_conversation_list',
      arguments: { limit: 20 },
    });
    expect(payload.result.structuredContent.result.items.map((item: { title: string }) => item.title)).toEqual(['owned']);
  });
});
