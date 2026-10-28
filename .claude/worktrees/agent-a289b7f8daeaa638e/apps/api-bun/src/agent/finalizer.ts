// 移植自 apps/api-rs/src/agent/finalizer.rs
import {
  canonicalizeCitationMarkers,
  citedEvidenceIndexes,
  resolveCitations,
} from './citation_resolver.ts';
import type { AnswerStream } from './stream.ts';
import type { ClaimVerifier } from './verifier/types.ts';
import type { AnswerStreamItem, CitationOutput } from '../models/agent.ts';
import type { EvidencePack } from '../models/rag.ts';
import type { Confidence, Usage } from '../models/index.ts';

export class GroundedAnswerFinalizer {
  constructor(private readonly verifier: ClaimVerifier) {}

  async finalize(
    query: string,
    candidate: string,
    evidence: EvidencePack,
    requireCitation: boolean,
    allowVerifierCorrection: boolean,
    usage: Usage | null,
  ): Promise<AnswerStream> {
    if (candidate.trim().length === 0) {
      throw new Error('grounded finalization received an empty candidate');
    }
    let answer = candidate;
    if (
      requireCitation &&
      citedEvidenceIndexes(answer).length === 0 &&
      evidence.chunks.length > 0
    ) {
      answer = answer.trimEnd() + ' [1]';
    }
    const report = await this.verifier.verify({
      question: query,
      draft_answer: answer,
      evidence,
      require_citation: requireCitation,
    });
    const candidateValid = citationsAreStructurallyValid(answer, evidence, requireCitation);
    let finalized: string;
    let confidence: Confidence;
    if (report.supported && candidateValid) {
      finalized = answer;
      confidence = report.confidence;
    } else if (allowVerifierCorrection) {
      const corrected = correctedAnswer(report.corrected_answer, evidence, requireCitation);
      if (corrected) {
        finalized = corrected[0];
        confidence = corrected[1];
      } else {
        finalized = answer;
        confidence = 'medium';
      }
    } else {
      const insufficient = insufficientAnswer();
      finalized = insufficient[0];
      confidence = insufficient[1];
    }
    const citations = resolveCitations(finalized, evidence);
    finalized = canonicalizeCitationMarkers(finalized, evidence);
    const finalUsage: Usage =
      usage ?? { input_tokens: 0, output_tokens: Math.floor(charCount(finalized) / 2) };
    return finalizedStream(finalized, citations, confidence, finalUsage);
  }

  componentName(): string {
    return this.verifier.componentName();
  }
}

function correctedAnswer(
  corrected: string | null,
  evidence: EvidencePack,
  requireCitation: boolean,
): [string, Confidence] | null {
  if (corrected === null) return null;
  const answer = corrected.trim();
  if (answer.length === 0 || !citationsAreStructurallyValid(answer, evidence, requireCitation)) {
    return null;
  }
  return [answer, 'medium'];
}

function insufficientAnswer(): [string, Confidence] {
  return ['现有文档证据不足以生成经过验证的可靠答案。', 'low'];
}

export function citationsAreStructurallyValid(
  answer: string,
  evidence: EvidencePack,
  requireCitation: boolean,
): boolean {
  const indexes = citedEvidenceIndexes(answer);
  if (requireCitation && indexes.length === 0) return false;
  return indexes.every((index) => index > 0 && index <= evidence.chunks.length);
}

async function* finalizedStream(
  answer: string,
  citations: CitationOutput[],
  confidence: Confidence,
  usage: Usage,
): AsyncGenerator<AnswerStreamItem> {
  yield { type: 'replace', text: answer };
  for (const citation of citations) {
    yield { type: 'citation', citation };
  }
  yield { type: 'completed', confidence, usage };
}

function charCount(text: string): number {
  return [...text].length;
}
