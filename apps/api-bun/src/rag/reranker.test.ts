// 移植自 apps/api-rs/src/rag/reranker.rs 的 #[cfg(test)] 用例
import { describe, expect, test } from 'bun:test';
import { parseRerankProvider, parseResults } from './reranker.ts';

describe('parseResults', () => {
  test('parses_dashscope_response', () => {
    const value = {
      output: {
        results: [
          { index: 1, relevance_score: 0.91 },
          { index: 0, relevance_score: 0.22 },
        ],
      },
    };
    const results = parseResults(value);
    expect(results.length).toBe(2);
    expect(results[0]!.index).toBe(1);
    expect(Math.abs(results[0]!.score - 0.91)).toBeLessThan(Number.EPSILON);
  });
});

describe('parseRerankProvider', () => {
  test('rejects_unknown_provider', () => {
    expect(() => parseRerankProvider('rule_based')).toThrow('unsupported rerank provider: rule_based');
  });
});
