// 移植自 apps/api-rs/src/rag/retriever.rs 的 #[cfg(test)] 用例
import { describe, expect, test } from 'bun:test';
import type { RetrievedChunk } from '../../models/rag.ts';
import { newUuid } from '../../infra/uuid.ts';
import { fuseRankedLists } from './fusion.ts';

function chunk(id: string, title: string, content: string): RetrievedChunk {
  return {
    chunk_id: id,
    doc_id: newUuid(),
    doc_title: title,
    file_type: 'txt',
    content,
    heading_path: [],
    page_range: [],
    block_ids: [],
    table_ids: [],
    anchor_ids: [],
    primary_anchor_id: null,
    anchor_quality: 'structural',
    primary_anchor: null,
    anchors: [],
    metadata: {},
    score: 1.0,
    source: 'dense',
  };
}

describe('fuseRankedLists', () => {
  test('every_query_contributes_an_independent_rrf_ranking', () => {
    const first = chunk('00000000-0000-0000-0000-000000000001', 'A', 'alpha');
    const second = chunk('00000000-0000-0000-0000-000000000002', 'B', 'beta');
    const fused = fuseRankedLists(
      [[first, second], [structuredClone(second), structuredClone(first)]],
      [],
      2,
    );
    expect(fused.length).toBe(2);
    expect(Math.abs(fused[0]!.score - fused[1]!.score)).toBeLessThan(Number.EPSILON);
  });

  test('keeps_the_best_result_from_each_query', () => {
    const first = chunk('00000000-0000-0000-0000-000000000001', 'A', 'alpha');
    const second = chunk('00000000-0000-0000-0000-000000000002', 'B', 'beta');
    const shared = chunk('00000000-0000-0000-0000-000000000003', 'C', 'shared');
    const fused = fuseRankedLists(
      [[first, shared], [second, structuredClone(shared)]],
      [],
      2,
    );
    expect(fused.map((item) => item.chunk_id)).toEqual([first.chunk_id, second.chunk_id]);
  });

  test('cross_channel_evidence_is_marked_as_rrf', () => {
    const shared = chunk('00000000-0000-0000-0000-000000000001', 'A', 'alpha');
    const other = chunk('00000000-0000-0000-0000-000000000002', 'B', 'beta');
    const fused = fuseRankedLists([[shared, other]], [[structuredClone(shared)]], 2);
    expect(fused[0]!.source).toBe('rrf');
  });

  test('exact_duplicate_content_is_removed_after_fusion', () => {
    const first = chunk('00000000-0000-0000-0000-000000000001', 'A', 'same text');
    const duplicate = chunk('00000000-0000-0000-0000-000000000002', 'A', 'same text');
    const fused = fuseRankedLists([[first, duplicate]], [], 5);
    expect(fused.length).toBe(1);
  });
});
