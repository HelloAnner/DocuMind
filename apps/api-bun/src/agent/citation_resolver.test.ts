// 移植自 apps/api-rs/src/agent/citation_resolver.rs 的 #[cfg(test)]
import { describe, expect, test } from 'bun:test';
import {
  canonicalizeCitationMarkers,
  citedEvidenceIndexes,
  resolveCitations,
} from './citation_resolver.ts';
import { newUuid } from '../infra/uuid.ts';
import { normalizedBBox, sourceAnchorForPdfParagraph } from '../models/source_anchor.ts';
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

  test('same_document_locations_keep_distinct_citations', () => {
    const first = evidenceChunk();
    const second = evidenceChunk();
    second.chunk.doc_id = first.chunk.doc_id;
    second.chunk.page_range = [2];
    const evidence = { chunks: [first, second], context_text: 'evidence' };

    const citations = resolveCitations('结论甲 [1]，结论乙 [2]', evidence);
    expect(citations.map((citation) => citation.index)).toEqual([1, 2]);
    expect(citations.map((citation) => citation.page_range)).toEqual([[1], [2]]);
    expect(canonicalizeCitationMarkers('结论甲 [1]，结论乙 [2]', evidence)).toBe(
      '结论甲 [1]，结论乙 [2]',
    );
  });

  test('duplicate_locations_share_one_marker_without_adjacent_duplicates', () => {
    const chunk = evidenceChunk();
    const evidence = { chunks: [chunk, chunk], context_text: 'evidence' };

    expect(resolveCitations('结论 [1][2]', evidence)).toHaveLength(1);
    expect(canonicalizeCitationMarkers('结论 [1][2]', evidence)).toBe('结论 [1]');
  });

  test('renumbers_citations_by_first_answer_occurrence', () => {
    const evidence = {
      chunks: [evidenceChunk(), evidenceChunk(), evidenceChunk()],
      context_text: 'evidence',
    };

    expect(canonicalizeCitationMarkers('先引用第三项 [3]，再引用第一项 [1]', evidence)).toBe(
      '先引用第三项 [1]，再引用第一项 [2]',
    );
    expect(resolveCitations('先引用第三项 [3]，再引用第一项 [1]', evidence)
      .map((citation) => citation.index)).toEqual([1, 2]);
  });

  test('selects_the_anchor_matching_the_adjacent_claim', () => {
    const evidence = evidenceChunk();
    evidence.chunk.file_type = 'pdf';
    evidence.chunk.content = '第一段金额100。第二段金额200。';
    const parseJobId = newUuid();
    const tenantId = newUuid();
    const first = sourceAnchorForPdfParagraph(
      evidence.chunk.doc_id, parseJobId, tenantId, newUuid(), 1, '第一段金额100',
      normalizedBBox(0.1, 0.7, 0.8, 0.8),
    );
    const second = sourceAnchorForPdfParagraph(
      evidence.chunk.doc_id, parseJobId, tenantId, newUuid(), 2, '第二段金额200',
      normalizedBBox(0.1, 0.4, 0.8, 0.5),
    );
    evidence.chunk.anchor_ids = [first.anchor_id, second.anchor_id];
    evidence.chunk.primary_anchor_id = first.anchor_id;
    evidence.chunk.primary_anchor = first;
    evidence.chunk.anchors = [first, second];

    const [citation] = resolveCitations('确认第二段金额200 [1]', {
      chunks: [evidence],
      context_text: 'evidence',
    });
    expect(citation?.anchor?.page).toBe(2);
    expect(citation?.quote).toContain('第二段金额200');
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
      anchors: [],
      metadata: {},
      score: 0.9,
      source: 'rrf',
    },
    score: 0.9,
    rank: 1,
  };
}
