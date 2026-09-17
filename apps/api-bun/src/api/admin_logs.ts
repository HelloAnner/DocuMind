// 移植自 apps/api-rs/src/api/admin.rs 的 logs 部分
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../http/types.ts';
import type { QaLogSummary } from '../models/identity.ts';
import { requireTenantAdmin } from '../auth/permissions.ts';
import { toRfc3339 } from '../infra/time.ts';

export function adminLogsRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/admin/logs', listLogs);
  return router;
}

async function listLogs(c: Context<AppEnv>) {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  const sql = state.sql;
  if (!sql) return c.json([]);

  const range = normalizeLogRange(c.req.query('range'));
  const rawQuery = c.req.query('q');
  const trimmed = rawQuery ? rawQuery.trim() : '';
  const q = trimmed.length > 0 ? `%${trimmed}%` : null;
  const rawLimit = Number(c.req.query('limit'));
  const limit = Math.min(200, Math.max(1,
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.trunc(rawLimit) : 100));

  const rows = await sql`
    SELECT a.id,
           COALESCE(u.content, '') AS question,
           COALESCE(NULLIF(string_agg(DISTINCT kb.name, ', '), ''), '未关联知识库') AS kb_name,
           COALESCE(au.name, au.email, '未知用户') AS user_name,
           CASE a.confidence
               WHEN 'high' THEN 0.95
               WHEN 'medium' THEN 0.75
               WHEN 'low' THEN 0.55
               ELSE 0.50
           END::double precision AS score,
           f.rating AS feedback,
           a.created_at
    FROM conversation_messages a
    LEFT JOIN conversation_messages u ON u.id = a.parent_message_id
    LEFT JOIN app_user au ON au.id = a.user_id
    LEFT JOIN conversation_feedback f ON f.assistant_message_id = a.id
    LEFT JOIN conversation_sessions s ON s.id = a.conversation_id
    LEFT JOIN knowledge_base kb
           ON kb.tenant_id = a.tenant_id
          AND kb.id = ANY(s.kb_ids)
    WHERE a.tenant_id = ${actor.tenant_id}
      AND a.role = 'assistant'
      AND a.status = 'completed'
      AND (
           ${range} = 'all'
           OR (${range} = 'today' AND a.created_at >= date_trunc('day', now()))
           OR (${range} = 'week' AND a.created_at >= now() - interval '7 days')
           OR (${range} = 'month' AND a.created_at >= now() - interval '30 days')
      )
      AND (
           ${q}::text IS NULL
           OR COALESCE(u.content, '') ILIKE ${q}
           OR COALESCE(au.name, '') ILIKE ${q}
           OR COALESCE(au.email, '') ILIKE ${q}
           OR COALESCE(kb.name, '') ILIKE ${q}
      )
    GROUP BY a.id, u.content, au.name, au.email, f.rating, a.confidence, a.created_at
    ORDER BY a.created_at DESC
    LIMIT ${limit}
  `;
  const logs: QaLogSummary[] = rows.map((row) => ({
    id: String(row.id),
    question: String(row.question),
    kb_name: String(row.kb_name),
    user_name: String(row.user_name),
    score: Number(row.score ?? 0),
    feedback: (row.feedback as string | null) ?? null,
    created_at: toRfc3339(new Date(row.created_at as Date | string)),
  }));
  return c.json(logs);
}

export function normalizeLogRange(value?: string): string {
  switch (value ?? 'today') {
    case 'today': return 'today';
    case 'week': return 'week';
    case 'month': return 'month';
    case 'all': return 'all';
    default: return 'today';
  }
}

