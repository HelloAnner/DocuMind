// 移植自 apps/api-rs/src/lib.rs 的 run() 与路由装配
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { toAppError } from './errors.ts';
import { buildState } from './state.ts';
import type { AppConfig } from './config.ts';
import { healthPayload, type HealthDeps } from './http/health.ts';
import { metricsPayload } from './http/metrics.ts';
import { configSnapshotPayload } from './http/config_snapshot.ts';
import { extractActorMiddleware } from './http/auth_middleware.ts';
import type { AppEnv } from './http/types.ts';
import { getAsset, fallbackHtml } from './web_assets.ts';
import {
  accountRouter, adminApiClientsRouter, adminMembersRouter, adminRouter, adminSkillsRouter, authRouter,
  conversationsRouter, documentsRouter, externalApiRouter, historyRouter, knowledgeRouter,
  systemRouter, systemTenantInvitationsRouter, systemTenantsRouter, tenantLoginRouter,
  vectorDiagnosticsRouter,
} from './api/mod.ts';
import { createDocumindMcpEndpoint } from './mcp.ts';

/** 与 Rust 保持一致：这些端点不使用 ActorExtractor（自行鉴权或完全公开）。 */
const PUBLIC_API_PATHS = new Set([
  '/api/health', '/api/metrics', '/api/config',
  '/api/auth/login', '/api/auth/refresh', '/api/auth/logout',
  '/api/auth/tenant-context',
  '/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/refresh',
  '/api/v1/auth/logout', '/api/v1/auth/me', '/api/v1/me', '/api/me',
  '/api/v1/auth/tenants',
  '/api/v1/auth/switch-tenant', '/api/v1/tenants',
  '/api/v1/invitations/validate', '/api/v1/invitations/accept', '/api/v1/auth/tenant-context',
  '/api/v1/permission/matrix',
]);
const PUBLIC_API_PATTERNS = [
  /^\/api\/files\/[^/]+\/preview\/(manifest|content|pages\/\d+\/pdf)$/,
];

function isPublicApiPath(rawPath: string): boolean {
  const path = rawPath.startsWith('/documind/') || rawPath === '/documind'
    ? rawPath.slice('/documind'.length)
    : rawPath;
  if (PUBLIC_API_PATHS.has(path)) return true;
  return PUBLIC_API_PATTERNS.some((pattern) => pattern.test(path));
}

export async function createApp(config: AppConfig): Promise<{ app: Hono<AppEnv>; state: import('./state.ts').AppState }> {
  const state = await buildState(config);

  const healthDeps: HealthDeps = {
    config,
    sql: state.sql,
    redis: state.redis,
    vectorConsistency: state.vectorConsistency,
  };

  // 业务 API 路由（与 Rust 一致：同时挂载在 / 与 /documind 下）
  const api = new Hono<AppEnv>();
  api.get('/api/health', async (c) => c.json(await healthPayload(healthDeps)));
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
  api.route('/', adminSkillsRouter());
  api.route('/', documentsRouter());
  api.route('/', knowledgeRouter());
  api.route('/', historyRouter());
  api.route('/', externalApiRouter());
  api.route('/', conversationsRouter());

  const app = new Hono<AppEnv>();
  app.use('*', logger());
  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['*'],
    exposeHeaders: ['*'],
  }));
  // 先注入 state，再做身份解析（仅 /api 路径需要身份）
  app.use('*', async (c, next) => {
    c.set('appState', state);
    await next();
  });
  const actorMiddleware = extractActorMiddleware((c) => ({
    state: c.get('appState'),
    config: c.get('appState').config,
    sql: c.get('appState').sql,
    redis: c.get('appState').redis,
    dbPoolPresent: c.get('appState').sql !== null,
  }));
  // Rust 里仅显式使用 ActorExtractor 的 handler 需要身份；下列端点自行鉴权或不鉴权
  app.use('/api/*', async (c, next) => {
    if (isPublicApiPath(c.req.path)) return next();
    return actorMiddleware(c, next);
  });
  app.use('/documind/api/*', async (c, next) => {
    if (isPublicApiPath(c.req.path)) return next();
    return actorMiddleware(c, next);
  });

  app.route('/', api);
  const mcpEndpoint = createDocumindMcpEndpoint(state);
  app.post('/mcp', mcpEndpoint);
  app.post('/documind/mcp', mcpEndpoint);
  app.route('/documind', api);

  // 静态资源 + SPA 回退
  app.all('*', (c) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/api/') || path.startsWith('/documind/api/')) {
      return c.json({ detail: 'not found' }, 404);
    }
    const asset = getAsset(path) ?? getAsset('/index.html') ?? fallbackHtml();
    return new Response(asset.bytes as unknown as ArrayBuffer, {
      status: 200, headers: { 'Content-Type': asset.contentType },
    });
  });

  app.onError((error, c) => {
    const appError = toAppError(error);
    return c.json(appError.toBody(), appError.httpStatus as 200);
  });
  app.notFound((c) => c.json({ detail: 'not found' }, 404));

  return { app, state };
}
