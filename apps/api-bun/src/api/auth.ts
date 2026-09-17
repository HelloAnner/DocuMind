// 桩文件：由移植代理替换为忠实移植实现
import { Hono } from 'hono';
import type { AppEnv } from '../http/types.ts';

export function authRouter(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
