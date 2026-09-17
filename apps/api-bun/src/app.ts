// 移植自 apps/api-rs/src/lib.rs 的 run() 与路由装配
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { AppError, toAppError } from './errors.ts';
import { buildState } from './state.ts';
import type { AppConfig } from './config.ts';
import { healthPayload, type HealthDeps } from './http/health.ts';
import { metricsPayload } from './http/metrics.ts';
import { configSnapshotPayload } from './http/config_snapshot.ts';
import { extractActorMiddleware } from './http/auth_middleware.ts';
import type { AppEnv } from './http/types.ts';
import { getAsset, fallbackHtml } from './web_assets.ts';
import {
  accountRouter, adminApiClientsRouter, adminMembersRouter, adminRouter, authRouter,
  conversationsRouter, documentsRouter, historyRouter, knowledgeRouter, runtimeEventsRouter,
  systemRouter, systemTenantInvitationsRouter, systemTenantsRouter, tenantLoginRouter,
  vectorDiagnosticsRouter,
} from './api/mod.ts';

export async function createApp(config: AppConfig): Promise<{ app: Hono<AppEnv>; state: import('./state.ts').AppState }> {
  const state = await buildState(config);

  const healthDeps: HealthDeps = {
    config,
    sql: state.sql,
    redis: state.redis,
    vectorConsistency: state.vectorConsistency,
  };

  const api = new Hono<AppEnv>();
  api.get('/api/metrics', async (c) => c.text(await metricsPayload(healthDeps), 200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
  }));
  api.get('/api/config', (c) => c.json(configSnapshotPayload(config)));
  api.route('/', authRouter());
  api.route('/', tenantLoginRouter());
  api.route('/', accountRouter());
  api.route('/', systemRouter());
  api.route('/', systemTenantsRouter());
  api.route('/', systemTenantInvitationsRouter());
  api.route('/', vectorDiagnosticsRouter());
  api.route('/', adminRouter());
  api.route('/', adminMembersRouter());
  api.route('/', adminApiClientsRouter());
  api.route('/', documentsRouter());
  api.route('/', knowledgeRouter());
  api.route('/', historyRouter());
  api.route('/', conversationsRouter());
  api.route('/', runtimeEventsRouter());

  const app = new Hono<AppEnv>();
  app.use(logger());
  app.use(cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['*'],
  }));
  // 先注入 state，再做身份解析
  app.use('*', async (c, next) => {
    c.set('appState', state);
    await next();
  });
  app.use('/api/*', extractActorMiddleware((c) => ({
    state: c.get('appState'),
    config: c.get('appState').config,
    sql: c.get('appState').sql,
    redis: c.get('appState').redis,
    dbPoolPresent: c.get('appState').sql !== null,
  })));

  const healthApi = new Hono<AppEnv>();
  healthApi.get('/api/health', async (c) => c.json(await healthPayload(healthDeps)));
  app.route('/', healthApi);
  app.route('/', api);
  app.route('/documind', api);

  // 静态资源 + SPA 回退
  app.all('*', (c) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/api/')) {
      return c.json({ detail: 'not found' }, 404);
    }
    const asset = getAsset(path) ?? getAsset('/index.html') ?? fallbackHtml();
    return c.body(asset.bytes as unknown as BodyInit, 200, { 'Content-Type': asset.contentType });
  });

  app.onError((error, c) => {
    const appError = toAppError(error);
    return c.json(appError.toBody(), appError.httpStatus as 200);
  });
  app.notFound((c) => c.json({ detail: 'not found' }, 404));

  return { app, state };
}
