// 移植自 apps/api-rs/src/repositories/sqlx.rs（会话/消息部分 + 行映射辅助）
// SqlxConversationCore 提供 session 与 message 的 SQL 实现；
// trace/citation/feedback 部分见 sqlx.ts 中的子类。
import type postgres from 'postgres';

import type { ConversationSession, ConversationListResponse } from '../models/conversation.ts';
import type { ConversationMessage } from '../models/message.ts';
import {
  parseConfidence, parseNoAnswerReasonCode, noAnswerReasonCode,
  type ConversationStatus, type MessageRole, type MessageStatus,
} from '../models/index.ts';
import { isAgentMode } from '../models/agent.ts';
import type { PromptVersions } from '../models/agent.ts';
import { toRfc3339 } from '../infra/time.ts';

export type Sql = ReturnType<typeof postgres>;
export type Row = postgres.Row;

// ---- 行取值辅助（对齐 Rust row.try_get 的显式错误） ----

export function strCol(row: Row, key: string): string {
  const value: unknown = row[key];
  if (typeof value !== 'string') throw new Error('column ' + key + ' is not a string');
  return value;
}

export function strOrNullCol(row: Row, key: string): string | null {
  const value: unknown = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('column ' + key + ' is not a string');
  return value;
}

export function dateCol(row: Row, key: string): string {
  const value: unknown = row[key];
  if (!(value instanceof Date)) throw new Error('column ' + key + ' is not a timestamptz');
  return toRfc3339(value);
}

export function dateOrNullCol(row: Row, key: string): string | null {
  const value: unknown = row[key];
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date)) throw new Error('column ' + key + ' is not a timestamptz');
  return toRfc3339(value);
}

export function numCol(row: Row, key: string): number {
  const value: unknown = row[key];
  if (typeof value !== 'number') throw new Error('column ' + key + ' is not a number');
  return value;
}

export function strListCol(row: Row, key: string): string[] {
  const value: unknown = row[key];
  if (!Array.isArray(value)) throw new Error('column ' + key + ' is not an array');
  return value as string[];
}

export function numListOrEmpty(row: Row, key: string): number[] {
  const value: unknown = row[key];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('column ' + key + ' is not an array');
  return value as number[];
}

export function strListOrEmpty(row: Row, key: string): string[] {
  const value: unknown = row[key];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('column ' + key + ' is not an array');
  return value as string[];
}

export function uuidListOrEmpty(row: Row, key: string): string[] {
  return strListOrEmpty(row, key);
}

/** 对齐 Rust row.try_get(...).ok()：任何异常都收敛为 null。 */
export function lenientOrNull<T>(row: Row, key: string): T | null {
  const value: unknown = row[key];
  if (value === null || value === undefined) return null;
  return value as T;
}

export function parseCursorOrZero(cursor: string | null): number {
  if (cursor === null) return 0;
  return /^\d+$/.test(cursor) ? parseInt(cursor, 10) : 0;
}

function parseConversationStatus(value: string): ConversationStatus {
  if (value === 'active' || value === 'archived' || value === 'deleted') return value;
  throw new Error('invalid conversation status: unknown conversation status: ' + value);
}

function parseMessageRoleOrDefault(value: string): MessageRole {
  return value === 'assistant' ? 'assistant' : 'user';
}

function parseMessageStatusOrDefault(value: string): MessageStatus {
  switch (value) {
    case 'answering': return 'answering';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'created';
  }
}

function parseConfidenceOrNull(value: string | null): ConversationMessage['confidence'] {
  if (value === null) return null;
  try {
    return parseConfidence(value);
  } catch {
    return null;
  }
}

function parsePromptVersionsOrNull(value: unknown): PromptVersions | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  return value as PromptVersions;
}

const MESSAGE_COLUMNS = `id, conversation_id, tenant_id, user_id, role, content, status,
                    parent_message_id, retry_of_message_id, client_request_id,
                    confidence, no_answer_reason, error_code, error_message,
                    agent_mode, prompt_versions, created_at, completed_at`;

export function parseMessage(row: Row): ConversationMessage {
  const promptJson: unknown = lenientOrNull(row, 'prompt_versions');
  const roleText = strCol(row, 'role');
  const statusText = strCol(row, 'status');
  const confidenceText = lenientOrNull<string>(row, 'confidence');
  const noAnswerText = lenientOrNull<string>(row, 'no_answer_reason');
  const agentModeText = lenientOrNull<string>(row, 'agent_mode');

  let noAnswerReason: ConversationMessage['no_answer_reason'] = null;
  if (noAnswerText !== null) {
    try {
      noAnswerReason = parseNoAnswerReasonCode(noAnswerText);
    } catch {
      noAnswerReason = null;
    }
  }

  return {
    id: strCol(row, 'id'),
    conversation_id: strCol(row, 'conversation_id'),
    tenant_id: strCol(row, 'tenant_id'),
    user_id: strCol(row, 'user_id'),
    role: parseMessageRoleOrDefault(roleText),
    content: strCol(row, 'content'),
    status: parseMessageStatusOrDefault(statusText),
    parent_message_id: lenientOrNull<string>(row, 'parent_message_id'),
    retry_of_message_id: lenientOrNull<string>(row, 'retry_of_message_id'),
    client_request_id: lenientOrNull<string>(row, 'client_request_id'),
    confidence: parseConfidenceOrNull(confidenceText),
    no_answer_reason: noAnswerReason,
    error_code: lenientOrNull<string>(row, 'error_code'),
    error_message: lenientOrNull<string>(row, 'error_message'),
    agent_mode: agentModeText !== null && isAgentMode(agentModeText) ? agentModeText : null,
    prompt_versions: parsePromptVersionsOrNull(promptJson),
    created_at: dateCol(row, 'created_at'),
    completed_at: dateOrNullCol(row, 'completed_at'),
  };
}

export { MESSAGE_COLUMNS };

/** 会话与消息的 SQL 实现（对应 Rust SqlxConversationRepository 的对应方法）。 */
export class SqlxConversationCore {
  protected readonly pool: Sql;

  constructor(pool: Sql) {
    this.pool = pool;
  }

  async createSession(session: ConversationSession): Promise<void> {
    await this.pool`
      INSERT INTO conversation_sessions (
        id, tenant_id, user_id, title, title_locked, kb_ids, status, summary, created_at, updated_at
      ) VALUES (${session.id}, ${session.tenant_id}, ${session.user_id}, ${session.title},
        ${session.title.trim() !== '新会话'}, ${session.kb_ids}, ${session.status},
        ${session.summary}, ${session.created_at}, ${session.updated_at})
    `;
  }

  async updateSessionTitle(
    tenantId: string, userId: string, conversationId: string, title: string, manual: boolean,
  ): Promise<boolean> {
    const result = await this.pool`
      UPDATE conversation_sessions
      SET title = ${title},
          title_locked = CASE WHEN ${manual} THEN TRUE ELSE title_locked END,
          updated_at = NOW()
      WHERE id = ${conversationId}
        AND tenant_id = ${tenantId}
        AND user_id = ${userId}
        AND status = 'active'
        AND (${manual} OR title_locked = FALSE)
    `;
    return result.count === 1;
  }

  async listSessions(
    tenantId: string, userId: string, limit: number, cursor: string | null,
  ): Promise<ConversationListResponse> {
    const offset = parseCursorOrZero(cursor);
    const rows = await this.pool`
      SELECT s.id, s.title, s.updated_at,
             (SELECT m.content FROM conversation_messages m
              WHERE m.conversation_id = s.id AND m.role = 'user' AND m.status = 'completed'
              ORDER BY m.created_at DESC LIMIT 1) as last_preview
      FROM conversation_sessions s
      WHERE s.tenant_id = ${tenantId} AND s.user_id = ${userId} AND s.status = 'active'
      ORDER BY s.updated_at DESC
      LIMIT ${limit + 1} OFFSET ${offset}
    `;

    const items = rows.map((row) => ({
      conversation_id: strCol(row, 'id'),
      title: strCol(row, 'title'),
      last_message_preview: strOrNullCol(row, 'last_preview'),
      updated_at: dateCol(row, 'updated_at'),
    }));

    const hasMore = items.length > limit;
    const page = items.slice(0, limit);
    const nextCursor = hasMore ? String(offset + limit) : null;
    return { items: page, next_cursor: nextCursor };
  }

  async getSession(tenantId: string, conversationId: string): Promise<ConversationSession | null> {
    const rows = await this.pool`
      SELECT id, tenant_id, user_id, title, kb_ids, status, summary, created_at, updated_at
      FROM conversation_sessions
      WHERE id = ${conversationId} AND tenant_id = ${tenantId}
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const status = parseConversationStatus(strCol(row, 'status'));
    return {
      id: strCol(row, 'id'),
      tenant_id: strCol(row, 'tenant_id'),
      user_id: strCol(row, 'user_id'),
      title: strCol(row, 'title'),
      kb_ids: uuidListOrEmpty(row, 'kb_ids'),
      status,
      summary: strOrNullCol(row, 'summary'),
      created_at: dateCol(row, 'created_at'),
      updated_at: dateCol(row, 'updated_at'),
    };
  }

  async updateSession(session: ConversationSession): Promise<void> {
    await this.pool`
      UPDATE conversation_sessions
      SET title = ${session.title}, kb_ids = ${session.kb_ids}, status = ${session.status},
          summary = ${session.summary}, updated_at = ${session.updated_at}
      WHERE id = ${session.id} AND tenant_id = ${session.tenant_id}
    `;
  }

  async createMessage(message: ConversationMessage): Promise<void> {
    await this.pool`
      INSERT INTO conversation_messages (
        id, conversation_id, tenant_id, user_id, role, content, status,
        parent_message_id, retry_of_message_id, client_request_id,
        confidence, no_answer_reason, error_code, error_message,
        agent_mode, prompt_versions, created_at, completed_at
      ) VALUES (${message.id}, ${message.conversation_id}, ${message.tenant_id}, ${message.user_id},
        ${message.role}, ${message.content}, ${message.status},
        ${message.parent_message_id}, ${message.retry_of_message_id}, ${message.client_request_id},
        ${message.confidence},
        ${message.no_answer_reason === null ? null : noAnswerReasonCode(message.no_answer_reason)},
        ${message.error_code}, ${message.error_message},
        ${message.agent_mode}, ${message.prompt_versions}, ${message.created_at}, ${message.completed_at})
    `;
  }

  async getMessage(tenantId: string, messageId: string): Promise<ConversationMessage | null> {
    const rows = await this.pool`
      SELECT ${this.pool(MESSAGE_COLUMNS)}
      FROM conversation_messages
      WHERE id = ${messageId} AND tenant_id = ${tenantId}
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return parseMessage(row);
  }

  async getMessages(tenantId: string, conversationId: string): Promise<ConversationMessage[]> {
    const rows = await this.pool`
      SELECT ${this.pool(MESSAGE_COLUMNS)}
      FROM conversation_messages
      WHERE conversation_id = ${conversationId} AND tenant_id = ${tenantId}
      ORDER BY created_at ASC
    `;
    return rows.map((row) => parseMessage(row));
  }

  async updateMessage(message: ConversationMessage): Promise<void> {
    await this.pool`
      UPDATE conversation_messages
      SET content = ${message.content}, status = ${message.status},
          parent_message_id = ${message.parent_message_id}, retry_of_message_id = ${message.retry_of_message_id},
          client_request_id = ${message.client_request_id}, confidence = ${message.confidence},
          no_answer_reason = ${message.no_answer_reason === null ? null : noAnswerReasonCode(message.no_answer_reason)},
          error_code = ${message.error_code}, error_message = ${message.error_message},
          agent_mode = ${message.agent_mode}, prompt_versions = ${message.prompt_versions},
          created_at = ${message.created_at}, completed_at = ${message.completed_at}
      WHERE id = ${message.id} AND tenant_id = ${message.tenant_id}
    `;
  }

  async findMessageByClientRequestId(
    tenantId: string, userId: string, clientRequestId: string,
  ): Promise<ConversationMessage | null> {
    const rows = await this.pool`
      SELECT ${this.pool(MESSAGE_COLUMNS)}
      FROM conversation_messages
      WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND client_request_id = ${clientRequestId}
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return parseMessage(row);
  }
}
