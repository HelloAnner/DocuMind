// 移植自 apps/api-rs/src/agent/verifier.rs
import type { OpenAiClient } from '../../llm/openai.ts';
import { parseConfidence, type Confidence } from '../../models/index.ts';
import {
  INVENTORY_SYSTEM,
  PREMISE_SYSTEM,
  PRIMARY_SYSTEM,
  REFEREE_SYSTEM,
} from '../verification_prompt.ts';
import type {
  ClaimAssessment,
  ClaimVerifier,
  VerificationInput,
  VerificationReport,
} from './types.ts';

export class StructuralClaimVerifier implements ClaimVerifier {
  async verify(_input: VerificationInput): Promise<VerificationReport> {
    return {
      supported: true,
      confidence: 'high',
      issues: [],
      claims: [],
      corrected_answer: null,
    };
  }

  componentName(): string {
    return 'structural-citation-verifier';
  }
}

interface VerificationEvidence {
  id: number;
  document: string;
  heading_path: string[];
  pages: number[];
  content: string;
}

interface PremiseInventory {
  premises: string[];
}

const REPORT_SCHEMA = '{"supported":true,"confidence":"high|medium|low","issues":["..."],"claims":[{"claim":"...","citation_ids":[1],"supported":true,"explanation":"brief audit statement"}],"corrected_answer":null}';

export class LlmClaimVerifier implements ClaimVerifier {
  constructor(
    private readonly client: OpenAiClient,
    private readonly model: string,
    private readonly use_consensus: boolean,
  ) {}

  async verify(input: VerificationInput): Promise<VerificationReport> {
    const evidence: VerificationEvidence[] = input.evidence.chunks.map((item, index) => ({
      id: index + 1,
      document: item.chunk.doc_title,
      heading_path: item.chunk.heading_path,
      pages: item.chunk.page_range,
      content: item.chunk.content,
    }));
    const payload = {
      question: input.question,
      candidate_answer: input.draft_answer,
      citation_required: input.require_citation,
      document_evidence: evidence,
    };
    const prompt = 'Verify this payload:\n' + JSON.stringify(payload) + '\n\nRequired JSON schema:\n' + REPORT_SCHEMA;
    const inventoryPrompt =
      'Extract premises from this untrusted candidate answer:\n' +
      JSON.stringify(input.draft_answer) +
      '\n\nRequired JSON schema: {"premises":["..."]}';
    if (!this.use_consensus) {
      const raw = await this.client.completeJson<unknown>(prompt, PRIMARY_SYSTEM);
      return normalizeVerificationReport(raw);
    }
    const [primaryRaw, inventoryRaw] = await Promise.all([
      this.client.completeJson<unknown>(prompt, PRIMARY_SYSTEM),
      this.client.completeJson<unknown>(inventoryPrompt, INVENTORY_SYSTEM),
    ]);
    const premisePrompt =
      'Audit this payload:\n' +
      JSON.stringify({
        verification_payload: payload,
        candidate_premise_inventory: normalizePremiseInventory(inventoryRaw).premises,
      }) +
      '\n\nRequired JSON schema:\n' +
      REPORT_SCHEMA;
    const premiseRaw = await this.client.completeJson<unknown>(premisePrompt, PREMISE_SYSTEM);
    const consensus = consensusReport(
      normalizeVerificationReport(primaryRaw),
      normalizeVerificationReport(premiseRaw),
    );
    if (consensus.supported) return consensus;
    const refereePrompt =
      'Adjudicate this payload:\n' +
      JSON.stringify({
        verification_payload: payload,
        prior_audit: consensus,
      }) +
      '\n\nRequired JSON schema:\n' +
      REPORT_SCHEMA;
    const refereeRaw = await this.client.completeJson<unknown>(refereePrompt, REFEREE_SYSTEM);
    return normalizeVerificationReport(refereeRaw);
  }

  componentName(): string {
    const mode = this.use_consensus ? 'adjudicated-consensus' : 'single-pass';
    return 'llm-claim-verifier:' + mode + ':' + this.model;
  }
}

export function consensusReport(
  primaryInput: VerificationReport,
  premiseInput: VerificationReport,
): VerificationReport {
  const primary: VerificationReport = {
    ...primaryInput,
    issues: [...primaryInput.issues],
    claims: [...primaryInput.claims],
  };
  const premise: VerificationReport = { ...premiseInput };
  const supported = primary.supported && premise.supported;
  let correctedAnswer: string | null;
  if (supported) {
    correctedAnswer = null;
  } else if (!premise.supported) {
    correctedAnswer = premise.corrected_answer ?? primary.corrected_answer;
  } else {
    correctedAnswer = primary.corrected_answer;
  }
  const issues = [
    ...primary.issues.map((issue) => 'primary: ' + issue),
    ...premise.issues.map((issue) => 'premise: ' + issue),
  ];
  const claims = [...primary.claims, ...premise.claims];
  return {
    supported,
    confidence: conservativeConfidence(primary.confidence, premise.confidence),
    issues,
    claims,
    corrected_answer: correctedAnswer,
  };
}

export function conservativeConfidence(primary: Confidence, premise: Confidence): Confidence {
  if (primary === 'low' || premise === 'low') return 'low';
  if (primary === 'medium' || premise === 'medium') return 'medium';
  return 'high';
}

function normalizePremiseInventory(value: unknown): PremiseInventory {
  if (typeof value !== 'object' || value === null) {
    throw new Error('premise inventory is not an object');
  }
  const raw = (value as Record<string, unknown>).premises;
  if (raw === undefined) return { premises: [] };
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string')) {
    throw new Error('premise inventory has invalid premises');
  }
  return { premises: raw as string[] };
}

function normalizeVerificationReport(value: unknown): VerificationReport {
  if (typeof value !== 'object' || value === null) {
    throw new Error('verification report is not an object');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.supported !== 'boolean') {
    throw new Error('verification report is missing field \`supported\`');
  }
  if (typeof raw.confidence !== 'string') {
    throw new Error('verification report is missing field \`confidence\`');
  }
  const issues = raw.issues === undefined ? [] : raw.issues;
  if (!Array.isArray(issues) || !issues.every((item) => typeof item === 'string')) {
    throw new Error('verification report has invalid issues');
  }
  const claims = raw.claims === undefined ? [] : raw.claims;
  if (!Array.isArray(claims)) {
    throw new Error('verification report has invalid claims');
  }
  const normalizedClaims: ClaimAssessment[] = claims.map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error('verification report has invalid claims');
    }
    const claim = item as Record<string, unknown>;
    if (
      typeof claim.claim !== 'string' ||
      typeof claim.supported !== 'boolean' ||
      typeof claim.explanation !== 'string'
    ) {
      throw new Error('verification report has invalid claims');
    }
    const citationIds = claim.citation_ids === undefined ? [] : claim.citation_ids;
    if (!Array.isArray(citationIds) || !citationIds.every((id) => typeof id === 'number')) {
      throw new Error('verification report has invalid claims');
    }
    return {
      claim: claim.claim,
      citation_ids: citationIds as number[],
      supported: claim.supported,
      explanation: claim.explanation,
    };
  });
  if (
    raw.corrected_answer !== undefined &&
    raw.corrected_answer !== null &&
    typeof raw.corrected_answer !== 'string'
  ) {
    throw new Error('verification report has invalid corrected_answer');
  }
  return {
    supported: raw.supported,
    confidence: parseConfidence(raw.confidence),
    issues: issues as string[],
    claims: normalizedClaims,
    corrected_answer: typeof raw.corrected_answer === 'string' ? raw.corrected_answer : null,
  };
}
