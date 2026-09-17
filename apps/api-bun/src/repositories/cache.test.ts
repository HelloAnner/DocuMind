// InMemoryAnswerCache 行为测试（Rust 端无对应 #[cfg(test)]，为端口契约补测试）
import { describe, expect, test } from 'bun:test';
import { InMemoryAnswerCache } from './cache.ts';

describe('InMemoryAnswerCache', () => {
  test('get returns null for missing key', async () => {
    const cache = new InMemoryAnswerCache();
    expect(await cache.get('nope')).toBeNull();
  });

  test('set then get returns the value', async () => {
    const cache = new InMemoryAnswerCache();
    const value = { answer: '你好', citations: [1, 2] };
    await cache.set('k1', value, 60);
    expect(await cache.get('k1')).toEqual(value);
  });

  test('expired entries are treated as missing', async () => {
    const cache = new InMemoryAnswerCache();
    await cache.set('k1', 'v', 0);
    expect(await cache.get('k1')).toBeNull();
  });

  test('delete removes the entry', async () => {
    const cache = new InMemoryAnswerCache();
    await cache.set('k1', 'v', 60);
    await cache.delete('k1');
    expect(await cache.get('k1')).toBeNull();
  });
});
