// 移植自 apps/api-rs/src/agent/verifier.rs 的 #[cfg(test)]
import { describe, expect, test } from 'bun:test';
import { consensusReport, StructuralClaimVerifier } from './index.ts';
import type { VerificationReport } from './types.ts';

function report(
  supported: boolean,
  confidence: VerificationReport['confidence'],
  correction: string | null,
): VerificationReport {
  return {
    supported,
    confidence,
    issues: supported ? [] : ['unsupported premise'],
    claims: [],
    corrected_answer: correction,
  };
}

describe('claim verifier', () => {
  test('consensus_rejects_when_premise_auditor_rejects', () => {
    const merged = consensusReport(
      report(true, 'high', null),
      report(false, 'low', 'safe correction [1]'),
    );
    expect(merged.supported).toBe(false);
    expect(merged.confidence).toBe('low');
    expect(merged.corrected_answer).toBe('safe correction [1]');
  });

  test('structural_verifier_leaves_semantic_auditing_disabled_explicitly', async () => {
    const verificationReport = await new StructuralClaimVerifier().verify({
      question: '问题',
      draft_answer: '回答 [1]',
      evidence: { chunks: [], context_text: '' },
      require_citation: true,
    });
    expect(verificationReport.supported).toBe(true);
    expect(verificationReport.confidence).toBe('high');
    expect(new StructuralClaimVerifier().componentName()).toBe('structural-citation-verifier');
  });
});
