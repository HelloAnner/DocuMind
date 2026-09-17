// 移植自 apps/api-rs/src/rag/vector_index/schema.rs 的 #[cfg(test)] 用例
import { describe, expect, test } from 'bun:test';
import { physicalIndexName } from './schema.ts';

describe('physicalIndexName', () => {
  test('physical_index_name_is_stable_and_safe', () => {
    expect(physicalIndexName('Chunks', 'text/embedding v3', 1024, 2)).toBe(
      'chunks-v2-text-embedding-v3-1024',
    );
  });
});
