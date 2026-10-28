import { expect, test } from 'bun:test';
import type { RerankedChunk } from '../../models/rag.ts';
import { mergeCoveredReranks } from './tools.ts';

function result(chunkId: string, score: number): RerankedChunk {
  return {
    chunk: { chunk_id: chunkId, doc_id: `${chunkId}-doc` } as RerankedChunk['chunk'],
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

test('adds the top result for documents that per-query rerank missed', () => {
  const nist = result('nist-one', 0.4);
  nist.chunk.doc_id = 'nist-doc';
  const ai = result('ai-one', 0.3);
  ai.chunk.doc_id = 'ai-doc';
  const merged = mergeCoveredReranks(
    [[result('table-one', 0.9)], [result('table-two', 0.8)]],
    [nist, ai],
    3,
  );

  expect(merged.map((item) => item.chunk.chunk_id)).toEqual([
    'table-one', 'table-two', 'nist-one',
  ]);
});
