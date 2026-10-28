import { Hono } from 'hono';
import type { Context } from 'hono';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import { uuidParam } from './conversations_support.ts';

export function sharesRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.post('/api/conversations/:conversation_id/share', createShareHandler);
  router.get('/api/shares/:token', getShareHandler);
  return router;
}

async function createShareHandler(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  const sql = state.sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '分享功能需要数据库');
  const conversationId = uuidParam(c, 'conversation_id');
  const sessions = await sql`
    SELECT title FROM conversation_sessions
    WHERE id = ${conversationId} AND tenant_id = ${actor.tenant_id}
      AND user_id = ${actor.user_id} AND status = 'active'
  `;
  if (sessions.length === 0) throw AppError.conversationNotFound();
  const request = await c.req.json().catch(() => ({})) as { title?: unknown };
  const requestedTitle = typeof request.title === 'string' ? request.title.trim() : '';
  const title = requestedTitle || String(sessions[0]!.title);
  const token = `shr_${crypto.randomUUID().replaceAll('-', '')}`;
  const rows = await sql`
    INSERT INTO conversation_shares (token, tenant_id, conversation_id, created_by, title)
    VALUES (${token}, ${actor.tenant_id}, ${conversationId}, ${actor.user_id}, ${title})
    ON CONFLICT (conversation_id, created_by)
    DO UPDATE SET title = EXCLUDED.title
    RETURNING token, title, created_at
  `;
  const share = rows[0]!;
  return c.json({
    token: String(share.token),
    title: String(share.title),
    created_at: share.created_at,
    share_url: `/documind/s/${String(share.token)}`,
  });
}

async function getShareHandler(c: Context<AppEnv>): Promise<Response> {
  const sql = c.get('appState').sql;
  if (!sql) throw AppError.badRequest('DB_REQUIRED', '分享功能需要数据库');
  const token = c.req.param('token');
  if (!token?.startsWith('shr_')) {
    throw AppError.notFound('SHARE_NOT_FOUND', '分享不存在或已失效');
  }
  const shares = await sql`
    UPDATE conversation_shares share
    SET view_count = share.view_count + 1
    FROM conversation_sessions session
    WHERE share.token = ${token} AND session.id = share.conversation_id
      AND session.status = 'active'
    RETURNING share.title, share.conversation_id, share.created_at, share.view_count
  `;
  if (shares.length === 0) {
    throw AppError.notFound('SHARE_NOT_FOUND', '分享不存在或已失效');
  }
  const share = shares[0]!;
  const conversationId = String(share.conversation_id);
  const messages = await sql`
    SELECT id, role, content, status, created_at, completed_at
    FROM conversation_messages
    WHERE conversation_id = ${conversationId}
    ORDER BY created_at, id
  `;
  const citations = await sql`
    SELECT assistant_message_id, id, index, doc_id, doc_title, page_range, quote, score
    FROM conversation_citations
    WHERE assistant_message_id IN (
      SELECT id FROM conversation_messages WHERE conversation_id = ${conversationId}
    )
    ORDER BY assistant_message_id, index
  `;
  return c.json({
    token,
    title: String(share.title),
    created_at: share.created_at,
    view_count: Number(share.view_count),
    messages: messages.map((message) => ({
      message_id: String(message.id),
      role: String(message.role),
      content: String(message.content),
      status: String(message.status),
      created_at: message.created_at,
      completed_at: message.completed_at,
      citations: citations
        .filter((citation) => String(citation.assistant_message_id) === String(message.id))
        .map((citation) => ({
          citation_id: String(citation.id),
          index: Number(citation.index),
          doc_id: String(citation.doc_id),
          doc_title: String(citation.doc_title),
          page_range: citation.page_range as number[],
          quote: String(citation.quote),
          score: Number(citation.score),
        })),
    })),
  });
}

