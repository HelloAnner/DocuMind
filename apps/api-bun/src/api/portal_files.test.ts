import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { portalFilesRouter } from './portal_files.ts';
import type { AppEnv } from '../http/types.ts';

test('service file API denies unconfigured and invalid tokens before database access', async () => {
  const old = process.env.PORTAL_INTERNAL_TOKEN;
  const app = new Hono<AppEnv>();
  app.route('/', portalFilesRouter());
  app.onError((error, c) => c.json({ error: error.message }, 401));
  try {
    delete process.env.PORTAL_INTERNAL_TOKEN;
    expect((await app.request('/api/portal/files')).status).toBe(401);
    process.env.PORTAL_INTERNAL_TOKEN = 'test-service-secret';
    expect((await app.request('/api/portal/files', { headers: { 'X-Portal-Internal-Token': 'wrong' } })).status).toBe(401);
  } finally {
    if (old === undefined) delete process.env.PORTAL_INTERNAL_TOKEN;
    else process.env.PORTAL_INTERNAL_TOKEN = old;
  }
});
