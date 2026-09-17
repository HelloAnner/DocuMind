// AnswerCache 端口的两种实现（端口定义见 types.ts）。
// 注意：Rust 端当前没有对应的 cache.rs 源文件，该接口为 TS 侧新增端口，
// 行为约定：value 以 JSON 序列化存储；get  miss 返回 null；set 带 TTL（秒）。
import type Redis from 'ioredis';
import type { AnswerCache } from './types.ts';

export class InMemoryAnswerCache implements AnswerCache {
  private readonly entries = new Map<string, { value: unknown; expiresAtMs: number }>();

  async get(cacheKey: string): Promise<unknown | null> {
    const entry = this.entries.get(cacheKey);
    if (entry === undefined) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.entries.delete(cacheKey);
      return null;
    }
    return entry.value;
  }

  async set(cacheKey: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.entries.set(cacheKey, { value, expiresAtMs: Date.now() + ttlSeconds * 1000 });
  }

  async delete(cacheKey: string): Promise<void> {
    this.entries.delete(cacheKey);
  }
}

export class RedisAnswerCache implements AnswerCache {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async get(cacheKey: string): Promise<unknown | null> {
    const raw = await this.redis.get(cacheKey);
    if (raw === null) return null;
    return JSON.parse(raw) as unknown;
  }

  async set(cacheKey: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(cacheKey, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async delete(cacheKey: string): Promise<void> {
    await this.redis.del(cacheKey);
  }
}
