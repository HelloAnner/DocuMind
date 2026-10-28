// A2A contextId -> DocuMind 本地会话映射（持久化在 a2a_thread 表）。
import { AppError } from '../errors.ts';
import { nowRfc3339 } from '../infra/time.ts';
import { newUuid } from '../infra/uuid.ts';
import type { ConversationSession } from '../models/conversation.ts';
import type { CurrentActor } from '../models/identity.ts';
import type { AppState } from '../state.ts';

export const A2A_MAX_CONTEXT_ID = 200;

/**
 * 同一个 Portal contextId 幂等复用同一条本地会话；
 * 会话被删除时重建并覆盖映射。contextId 被其他用户占用则拒绝。
 */
export async function resolveA2AConversation(
  state: AppState, actor: CurrentActor, contextId: string,
): Promise<ConversationSession> {
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DATABASE_REQUIRED', 'A2A 需要 PostgreSQL');
  const existing = await sql`
    SELECT conversation_id, user_id, tenant_id FROM a2a_thread
    WHERE portal_context_id = ${contextId} LIMIT 1
  `;
  if (existing.length > 0) {
    assertOwner(existing[0]!, actor);
    const session = await state.repository.getSession(
      actor.tenant_id, String(existing[0]!.conversation_id));
    if (session !== null && session.user_id === actor.user_id && session.status === 'active') {
      return session;
    }
    const fresh = newSession(actor);
    await state.repository.createSession(fresh);
    await sql`
      UPDATE a2a_thread SET conversation_id = ${fresh.id}, updated_at = NOW()
      WHERE portal_context_id = ${contextId}
    `;
    return fresh;
  }

  // a2a_thread.conversation_id 有外键，必须先落本地会话再写映射。
  const session = newSession(actor);
  await state.repository.createSession(session);
  const inserted = await sql`
    INSERT INTO a2a_thread (portal_context_id, tenant_id, user_id, conversation_id)
    VALUES (${contextId}, ${actor.tenant_id}, ${actor.user_id}, ${session.id})
    ON CONFLICT (portal_context_id) DO NOTHING
    RETURNING conversation_id
  `;
  if (inserted.length > 0) return session;
  // 并发下另一请求先写入：复用已存在的映射
  const rows = await sql`
    SELECT conversation_id, user_id, tenant_id FROM a2a_thread
    WHERE portal_context_id = ${contextId} LIMIT 1
  `;
  if (rows.length === 0) throw AppError.internal('A2A 会话映射写入失败');
  assertOwner(rows[0]!, actor);
  const mapped = await state.repository.getSession(
    actor.tenant_id, String(rows[0]!.conversation_id));
  if (mapped === null || mapped.status !== 'active') {
    throw AppError.internal('A2A 会话映射指向的系统会话不可用');
  }
  return mapped;
}

function assertOwner(row: Record<string, unknown>, actor: CurrentActor): void {
  if (String(row.user_id) !== actor.user_id || String(row.tenant_id) !== actor.tenant_id) {
    throw AppError.forbidden();
  }
}

function newSession(actor: CurrentActor): ConversationSession {
  return {
    id: newUuid(),
    tenant_id: actor.tenant_id,
    user_id: actor.user_id,
    title: '门户对话',
    kb_ids: [...actor.allowed_kb_ids],
    status: 'active',
    summary: null,
    created_at: nowRfc3339(),
    updated_at: nowRfc3339(),
  };
}
