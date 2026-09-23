import { describe, expect, test } from 'bun:test';
import type { ConversationMessage } from '../models/message.ts';
import type { Sql } from './sqlx_core.ts';
import { SqlxConversationCore } from './sqlx_core.ts';

const TENANT = '00000000-0000-4000-8000-000000000011';
const USER = '00000000-0000-4000-8000-000000000012';
const CONVERSATION = '00000000-0000-4000-8000-000000000013';
const USER_MESSAGE = '00000000-0000-4000-8000-000000000014';
const ASSISTANT_MESSAGE = '00000000-0000-4000-8000-000000000015';
const FILE = '00000000-0000-4000-8000-000000000016';

describe('SqlxConversationCore.createMessagePair', () => {
  for (const [failAt, label] of [
    [1, 'user message'],
    [2, 'file binding'],
    [3, 'attachment link'],
    [4, 'assistant placeholder'],
  ] as const) {
    test(`rolls back every write when ${label} fails`, async () => {
      const { sql, state } = transactionalSql(failAt);
      const repository = new SqlxConversationCore(sql);

      await expect(repository.createMessagePair(
        message(USER_MESSAGE, 'user', null),
        message(ASSISTANT_MESSAGE, 'assistant', USER_MESSAGE),
        [FILE],
      )).rejects.toThrow(`step ${failAt} failed`);

      expect(state.messages).toEqual([]);
      expect(state.conversationId).toBeNull();
      expect(state.links).toEqual([]);
    });
  }

  test('commits both messages, binding and attachment link together', async () => {
    const { sql, state } = transactionalSql(null);
    const repository = new SqlxConversationCore(sql);
    await repository.createMessagePair(
      message(USER_MESSAGE, 'user', null),
      message(ASSISTANT_MESSAGE, 'assistant', USER_MESSAGE),
      [FILE],
    );

    expect(state.messages).toEqual([USER_MESSAGE, ASSISTANT_MESSAGE]);
    expect(state.conversationId).toBe(CONVERSATION);
    expect(state.links).toEqual([`${USER_MESSAGE}:${FILE}`]);
  });
});

function transactionalSql(failAt: number | null): { sql: Sql; state: TransactionState } {
  const state: TransactionState = { messages: [], conversationId: null, links: [] };
  const sql = {
    async begin(callback: (tx: { unsafe: (query: string, values: unknown[]) => Promise<any[]> }) => Promise<unknown>) {
      const staged: TransactionState = {
        messages: [...state.messages], conversationId: state.conversationId, links: [...state.links],
      };
      let step = 0;
      const tx = {
        async unsafe(query: string, values: unknown[]) {
          step += 1;
          if (step === failAt) throw new Error(`step ${step} failed`);
          if (query.startsWith('INSERT INTO conversation_messages')) {
            staged.messages.push(String(values[0]));
            return [];
          }
          if (query.startsWith('UPDATE user_file SET conversation_id')) {
            staged.conversationId = String(values[0]);
            return [{ id: FILE }];
          }
          if (query.startsWith('INSERT INTO conversation_message_file')) {
            staged.links.push(`${String(values[0])}:${FILE}`);
            return [];
          }
          throw new Error(`unexpected SQL: ${query}`);
        },
      };
      const result = await callback(tx);
      state.messages = staged.messages;
      state.conversationId = staged.conversationId;
      state.links = staged.links;
      return result;
    },
  } as unknown as Sql;
  return { sql, state };
}

interface TransactionState {
  messages: string[];
  conversationId: string | null;
  links: string[];
}

function message(
  id: string,
  role: 'user' | 'assistant',
  parentMessageId: string | null,
): ConversationMessage {
  return {
    id,
    conversation_id: CONVERSATION,
    tenant_id: TENANT,
    user_id: USER,
    role,
    content: role === 'user' ? 'question' : '',
    status: role === 'user' ? 'completed' : 'answering',
    parent_message_id: parentMessageId,
    retry_of_message_id: null,
    client_request_id: role === 'user' ? 'request-1' : null,
    confidence: null,
    no_answer_reason: null,
    error_code: null,
    error_message: null,
    agent_mode: null,
    prompt_versions: null,
    answer_source: 'rag',
    correction_id: null,
    correction_version_id: null,
    correction_match_type: null,
    correction_match_score: null,
    created_at: '2026-01-01T00:00:00.000Z',
    completed_at: role === 'user' ? '2026-01-01T00:00:00.000Z' : null,
  };
}
