// 移植自 apps/api-rs/src/api/history.rs
import { Hono } from 'hono';
import type { AppEnv } from '../http/types.ts';

export function historyRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/history', async (c) => {
    const state = c.get('appState');
    const actor = c.get('actor');
    const limitRaw = c.req.query('limit');
    const limit = limitRaw !== undefined && limitRaw !== '' ? Number(limitRaw) : 50;
    const cursor = c.req.query('cursor') ?? null;
    const response = await state.repository.listSessions(
      actor.tenant_id, actor.user_id, Number.isFinite(limit) ? limit : 50, cursor);
    return c.json(response);
  });
  return router;
}
