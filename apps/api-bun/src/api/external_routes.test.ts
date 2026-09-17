// 外部开放 API：Bearer 前缀校验与路由作用域
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { AppError, toAppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import { externalApiRouter } from './external_routes.ts';

function testApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route('/', externalApiRouter());
  app.get('/api/health', (c) => c.text('ok'));
  app.onError((error, c) => {
    const appError = error instanceof AppError ? error : toAppError(error);
    return c.json(appError.toBody(), appError.httpStatus as 200);
  });
  return app;
}

describe('externalApiRouter', () => {
  test('缺少 Authorization 时返回 INVALID_API_TOKEN', async () => {
    const response = await testApp().request('/api/v1/external/me');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: 'INVALID_API_TOKEN', message: 'API Token 无效',
    });
  });

  test('非 dm_live_ 前缀的 Bearer 同样被拒绝', async () => {
    const response = await testApp().request('/api/v1/external/me', {
      headers: { Authorization: 'Bearer sk-not-a-documind-token' },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: 'INVALID_API_TOKEN', message: 'API Token 无效',
    });
  });

  test('中间件只覆盖 /api/v1/external/*', async () => {
    const response = await testApp().request('/api/health');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });
});
