// 移植自 apps/api-rs/src/models/message.rs
import type { AgentMode, PromptVersions, ReactStepTrace } from './agent.ts';
import type { Citation, CitationAnchor } from './citation.ts';
import type { FeedbackResponse } from './feedback.ts';
import type { Confidence, MessageRole, MessageStatus, NoAnswerReason } from './index.ts';

export interface ConversationMessage {
  id: string; conversation_id: string; tenant_id: string; user_id: string;
  role: MessageRole; content: string; status: MessageStatus;
  parent_message_id: string | null; retry_of_message_id: string | null;
  client_request_id: string | null;
  confidence: Confidence | null; no_answer_reason: NoAnswerReason | null;
  error_code: string | null; error_message: string | null;
  agent_mode: AgentMode | null; prompt_versions: PromptVersions | null;
  created_at: string; completed_at: string | null;
}

export interface CitationResponse {
  index: number; doc_id: string; chunk_id: string; doc_title: string; page_range: number[];
  quote: string; source_status: string; anchor?: CitationAnchor | null;
}
export function citationToResponse(citation: Citation): CitationResponse {
  return {
    index: citation.index, doc_id: citation.doc_id, chunk_id: citation.chunk_id,
    doc_title: citation.doc_title, page_range: citation.page_range, quote: citation.quote,
    source_status: citation.source_status, anchor: citation.anchor,
  };
}

export interface MessageResponse {
  message_id: string; role: string; content: string; status: string;
  confidence: string | null; no_answer_reason: string | null; agent_mode: string | null;
  prompt_versions: PromptVersions | null;
  citations: CitationResponse[]; reasoning_steps: ReactStepTrace[];
  feedback?: FeedbackResponse | null;
  parent_message_id: string | null; retry_of_message_id: string | null;
  created_at: string; completed_at: string | null;
}

export interface SendMessageRequest {
  content: string; kb_ids?: string[]; client_request_id?: string | null; stream?: boolean;
}
export interface MessageListResponse { conversation_id: string; messages: MessageResponse[]; }
export interface RetryMessageRequest { stream?: boolean; }
