// 移植自 apps/api-rs/src/agent/verifier.rs 的 ClaimVerifier 端口
import type { EvidencePack } from '../../models/rag.ts';
import type { Confidence } from '../../models/index.ts';

export interface ClaimAssessment {
  claim: string;
  citation_ids: number[];
  supported: boolean;
  explanation: string;
}

export interface VerificationInput {
  question: string;
  draft_answer: string;
  evidence: EvidencePack;
  require_citation: boolean;
}

export interface VerificationReport {
  supported: boolean;
  confidence: Confidence;
  issues: string[];
  claims: ClaimAssessment[];
  corrected_answer: string | null;
}

export interface ClaimVerifier {
  verify(input: VerificationInput): Promise<VerificationReport>;
  componentName(): string;
}
