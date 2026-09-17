// 移植自 apps/api-rs/src/api/knowledge.rs
import { Hono } from 'hono';
import type { AppEnv } from '../http/types.ts';
import type { KnowledgeBaseSummary } from '../models/identity.ts';
import { toRfc3339 } from '../infra/time.ts';

export function knowledgeRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/knowledge-bases', async (c) => {
    const state = c.get('appState');
    const actor = c.get('actor');
    if (!actor.permissions.includes('kb.read') || actor.allowed_kb_ids.length === 0) {
      return c.json([]);
    }
    const sql = state.sql;
    if (sql) {
      const rows = await sql`
        SELECT kb.id, kb.tenant_id, kb.name, kb.description, kb.status, kb.tags,
               COUNT(DISTINCT d.id)::bigint AS doc_count,
               COUNT(c.id)::bigint AS chunk_count,
               kb.updated_at
        FROM knowledge_base kb
        LEFT JOIN documents d
               ON d.kb_id = kb.id
              AND d.tenant_id = kb.tenant_id
              AND d.parse_status <> 'deleted'
        LEFT JOIN chunks c
               ON c.doc_id = d.id
              AND d.latest_parse_job_id = c.parse_job_id
        WHERE kb.tenant_id = ${actor.tenant_id} AND kb.id = ANY(${actor.allowed_kb_ids})
        GROUP BY kb.id
        ORDER BY kb.updated_at DESC
      `;
      const summaries: KnowledgeBaseSummary[] = rows.map((row) => ({
        id: String(row.id), tenant_id: String(row.tenant_id), name: String(row.name),
        description: (row.description as string | null) ?? null, status: String(row.status),
        tags: (row.tags as string[]) ?? [],
        doc_count: Number(row.doc_count ?? 0), chunk_count: Number(row.chunk_count ?? 0),
        query_count: 0, updated_at: toRfc3339(new Date(row.updated_at as Date | string)),
      }));
      return c.json(summaries);
    }
    return c.json([{
      id: state.config.defaultKbIds[0] ?? '00000000-0000-0000-0000-000000000000',
      tenant_id: actor.tenant_id, name: '产品文档库',
      description: '面向全公司的产品手册与白皮书集合', status: 'active', tags: ['产品'],
      doc_count: 3201, chunk_count: 4832, query_count: 1204, updated_at: toRfc3339(new Date()),
    } satisfies KnowledgeBaseSummary]);
  });
  return router;
}
