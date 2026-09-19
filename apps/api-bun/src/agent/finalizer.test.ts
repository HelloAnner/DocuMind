// 移植自 apps/api-rs/src/agent/finalizer.rs 的 #[cfg(test)]
import { describe, expect, test } from 'bun:test';
import {
  citationsAreStructurallyValid,
  GroundedAnswerFinalizer,
} from './finalizer.ts';
import { newUuid } from '../infra/uuid.ts';
import type { EvidencePack, RerankedChunk } from '../models/rag.ts';
import type { Confidence } from '../models/index.ts';
import type { ClaimVerifier, VerificationReport } from './verifier/types.ts';

class CountingVerifier implements ClaimVerifier {
  calls = 0;
  constructor(private readonly report: VerificationReport) {}
  async verify(_input: {
    question: string;
    draft_answer: string;
    evidence: EvidencePack;
    require_citation: boolean;
  }): Promise<VerificationReport> {
    this.calls += 1;
    return this.report;
  }
  componentName(): string {
    return 'counting-verifier';
  }
}

describe('grounded answer finalizer', () => {
  test('citation_ids_must_exist', () => {
    const evidence: EvidencePack = { chunks: [], context_text: '' };
    expect(citationsAreStructurallyValid('事实 [1]', evidence, true)).toBe(false);
    expect(citationsAreStructurallyValid('普通回复', evidence, false)).toBe(true);
  });

  test('relevant_answer_is_kept_when_verifier_cannot_correct_it', async () => {
    const verifier = new CountingVerifier({
      supported: false,
      confidence: 'low',
      issues: ['citations are missing'],
      claims: [],
      corrected_answer: null,
    });
    const finalizer = new GroundedAnswerFinalizer(verifier);
    const stream = await finalizer.finalize(
      '有哪些岗位职责？',
      '钻井大组长负责任务分发和自检，承包商负责班组任务。',
      evidencePack(),
      true,
      true,
      null,
    );
    let answer = '';
    let confidence: Confidence | null = null;
    for await (const item of stream) {
      if (item.type === 'replace') answer = item.text;
      if (item.type === 'completed') confidence = item.confidence;
    }

    expect(answer).toContain('钻井大组长');
    expect(answer).not.toContain('证据不足');
    expect(confidence).toBe('medium');
  });

  test('verifier_correction_is_used_without_another_generation_call', async () => {
    const verifier = new CountingVerifier({
      supported: false,
      confidence: 'low',
      issues: ['candidate is unsupported'],
      claims: [],
      corrected_answer: '经核验，验证码是 73941。[1]',
    });
    const finalizer = new GroundedAnswerFinalizer(verifier);
    const stream = await finalizer.finalize(
      '验证码是什么？',
      '验证码是 00000。[1]',
      evidencePack(),
      true,
      true,
      null,
    );
    let answer = '';
    let confidence: Confidence | null = null;
    let citationCount = 0;
    for await (const item of stream) {
      if (item.type === 'delta') answer += item.text;
      if (item.type === 'replace') answer = item.text;
      if (item.type === 'citation') citationCount += 1;
      if (item.type === 'completed') confidence = item.confidence;
    }

    expect(verifier.calls).toBe(1);
    expect(answer).toContain('73941');
    expect(citationCount).toBe(1);
    expect(confidence).toBe('medium');
  });
});

function evidencePack(): EvidencePack {
  const chunk: RerankedChunk = {
    chunk: {
      chunk_id: newUuid(),
      doc_id: newUuid(),
      doc_title: 'OCR smoke',
      file_type: 'pdf',
      content: '验证码：73941',
      heading_path: [],
      page_range: [1],
      block_ids: [],
      table_ids: [],
      anchor_ids: [],
      primary_anchor_id: null,
      anchor_quality: 'structural',
      primary_anchor: null,
      anchors: [],
      metadata: {},
      score: 0.9,
      source: 'rrf',
    },
    score: 0.95,
    rank: 1,
  };
  return { chunks: [chunk], context_text: '[1] 验证码：73941' };
}
