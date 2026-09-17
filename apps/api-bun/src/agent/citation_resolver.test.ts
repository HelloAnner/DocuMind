// 移植自 apps/api-rs/src/agent/citation_resolver.rs 的 #[cfg(test)]
import { describe, expect, test } from 'bun:test';
import {
  canonicalizeCitationMarkers,
  citedEvidenceIndexes,
  resolveCitations,
} from './citation_resolver.ts';
import { newUuid } from '../infra/uuid.ts';
import type { RerankedChunk } from '../models/rag.ts';

describe('citation resolver', () => {
  test('parses_adjacent_and_grouped_citation_markers', () => {
    expect(citedEvidenceIndexes('结论 [1, 2][3]')).toEqual([1, 2, 3]);
  });

  test('answer_without_markers_does_not_receive_automatic_citations', () => {
    const evidence = { chunks: [evidenceChunk()], context_text: 'evidence' };
    expect(resolveCitations('没有引用标记的答案', evidence)).toHaveLength(0);
  });

  test('out_of_range_markers_do_not_map_to_another_chunk', () => {
    const evidence = { chunks: [evidenceChunk()], context_text: 'evidence' };
    expect(resolveCitations('错误引用 [2]', evidence)).toHaveLength(0);
  });

  test('one_document_produces_one_source_and_one_marker_number', () => {
    const first = evidenceChunk();
    const second = evidenceChunk();
    second.chunk.doc_id = first.chunk.doc_id;
    second.chunk.page_range = [2];
    const evidence = { chunks: [first, second], context_text: 'evidence' };

    expect(resolveCitations('结论甲 [1]，结论乙 [2]', evidence)).toHaveLength(1);
    expect(canonicalizeCitationMarkers('结论甲 [1]，结论乙 [2]', evidence)).toBe(
      '结论甲 [1]，结论乙 [1]',
    );
  });
});

function evidenceChunk(): RerankedChunk {
  return {
    chunk: {
      chunk_id: newUuid(),
      doc_id: newUuid(),
      doc_title: '测试文档',
      file_type: 'docx',
      content: '可核验的文档事实',
      heading_path: [],
      page_range: [1],
      block_ids: [],
      table_ids: [],
      anchor_ids: [],
      primary_anchor_id: null,
      anchor_quality: 'page_only',
      primary_anchor: null,
      metadata: {},
      score: 0.9,
      source: 'rrf',
    },
    score: 0.9,
    rank: 1,
  };
}
