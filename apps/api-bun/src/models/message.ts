// 移植自 apps/api-rs/src/models/message.rs
import type { AgentMode, PromptVersions, ReactStepTrace } from './agent.ts';
import type { Citation, CitationAnchor } from './citation.ts';
import type { FeedbackResponse } from './feedback.ts';
import type { Confidence, MessageRole, MessageStatus, NoAnswerReason } from './index.ts';
import type { UserFile } from './user_file.ts';

export type AnswerSource = 'rag' | 'manual_correction';
export type CorrectionMatchType = 'exact' | 'alias' | 'semantic';

export interface ConversationMessage {
  id: string; conversation_id: string; tenant_id: string; user_id: string;
  role: MessageRole; content: string; status: MessageStatus;
  parent_message_id: string | null; retry_of_message_id: string | null;
  client_request_id: string | null;
  confidence: Confidence | null; no_answer_reason: NoAnswerReason | null;
  error_code: string | null; error_message: string | null;
  agent_mode: AgentMode | null; prompt_versions: PromptVersions | null;
  answer_source: AnswerSource; correction_id: string | null; correction_version_id: string | null;
  correction_match_type: CorrectionMatchType | null; correction_match_score: number | null;
  created_at: string; completed_at: string | null;
}

export interface CitationResponse {
  citation_id: string; index: number; doc_id: string; chunk_id: string; doc_title: string;
  page_range: number[]; quote: string; source_status: string; anchor?: CitationAnchor | null;
}
export function citationToResponse(citation: Citation): CitationResponse {
  const response: CitationResponse = {
    citation_id: citation.id, index: citation.index, doc_id: citation.doc_id,
    chunk_id: citation.chunk_id, doc_title: citation.doc_title, page_range: citation.page_range,
    quote: citation.quote, source_status: citation.source_status,
  };
  // Rust: #[serde(skip_serializing_if = "Option::is_none")] —— 无 anchor 时省略该键
  if (citation.anchor !== null) response.anchor = citation.anchor;
  return response;
}

export interface MessageResponse {
  message_id: string; role: string; content: string; status: string;
  confidence: string | null; no_answer_reason: string | null; agent_mode: string | null;
  prompt_versions: PromptVersions | null;
  citations: CitationResponse[]; reasoning_steps: ReactStepTrace[];
  files: UserFile[];
  feedback?: FeedbackResponse | null;
  answer_source: AnswerSource; correction_id: string | null; correction_version_id: string | null;
  correction_match_type: CorrectionMatchType | null; correction_match_score: number | null;
  parent_message_id: string | null; retry_of_message_id: string | null;
  created_at: string; completed_at: string | null;
}

export interface SendMessageRequest {
  content: string; kb_ids?: string[]; file_ids?: string[];
  client_request_id?: string | null; stream?: boolean;
  model_id?: string; thinking_enabled?: boolean;
}
export interface MessageListResponse { conversation_id: string; messages: MessageResponse[]; }
export interface RetryMessageRequest { stream?: boolean; }
