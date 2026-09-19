import { expect, test } from 'bun:test';
import type { RerankedChunk } from '../../models/rag.ts';
import { mergeCoveredReranks } from './tools.ts';

function result(chunkId: string, score: number): RerankedChunk {
  return {
    chunk: { chunk_id: chunkId } as RerankedChunk['chunk'],
    score,
    rank: 1,
  };
}

test('keeps one result for every generated query before global rerank results', () => {
  const merged = mergeCoveredReranks(
    [[result('security', 0.4)], [result('ai-risk', 0.3)], [result('tables', 0.2)]],
    [result('tables', 0.9), result('other', 0.8), result('security', 0.7)],
    4,
  );

  expect(merged.map((item) => item.chunk.chunk_id)).toEqual([
    'security', 'ai-risk', 'tables', 'other',
  ]);
  expect(merged.map((item) => item.rank)).toEqual([1, 2, 3, 4]);
});
