// 移植自 apps/api-rs/src/models/mod.rs
export type Confidence = 'high' | 'medium' | 'low';
export const confidences: Confidence[] = ['high', 'medium', 'low'];
export function parseConfidence(value: string): Confidence {
  if (confidences.includes(value as Confidence)) return value as Confidence;
  throw new Error('unknown confidence: ' + value);
}

export type NoAnswerReason =
  | 'no_relevant_chunks' | 'needs_clarification' | 'scope_denied' | 'pipeline_timeout' | 'llm_timeout';
export const NO_ANSWER_REASON_CODES: Record<NoAnswerReason, string> = {
  no_relevant_chunks: 'NO_RELEVANT_CHUNKS',
  needs_clarification: 'NEEDS_CLARIFICATION',
  scope_denied: 'SCOPE_DENIED',
  pipeline_timeout: 'PIPELINE_TIMEOUT',
  llm_timeout: 'LLM_TIMEOUT',
};
export function noAnswerReasonCode(reason: NoAnswerReason): string { return NO_ANSWER_REASON_CODES[reason]; }
export function parseNoAnswerReasonCode(code: string): NoAnswerReason {
  for (const [reason, reasonCode] of Object.entries(NO_ANSWER_REASON_CODES)) {
    if (reasonCode === code) return reason as NoAnswerReason;
  }
  throw new Error('unknown no answer reason: ' + code);
}

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'created' | 'answering' | 'completed' | 'failed' | 'cancelled';
export type ConversationStatus = 'active' | 'archived' | 'deleted';

export interface Usage { input_tokens: number; output_tokens: number; }
