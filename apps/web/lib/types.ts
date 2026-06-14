export type UUID = string;

export type MessageRole = "user" | "assistant";
export type MessageStatus = "created" | "answering" | "completed" | "failed" | "cancelled";
export type Confidence = "high" | "medium" | "low";
export type Rating = "up" | "down";
export type FeedbackReason =
  | "helpful"
  | "wrong_answer"
  | "missing_source"
  | "outdated"
  | "not_helpful"
  | "other";

export interface Conversation {
  conversation_id: UUID;
  title: string;
  last_message_preview?: string;
  updated_at: string;
}

export interface Citation {
  index: number;
  doc_id: UUID;
  chunk_id: UUID;
  doc_title: string;
  page_range: number[];
  quote: string;
}

export interface PromptVersions {
  persona: string;
  guardrail: string;
  mode: string;
  task: string;
}

export interface Message {
  message_id: UUID;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  confidence?: Confidence;
  no_answer_reason?: string;
  agent_mode?: string;
  prompt_versions?: PromptVersions;
  citations: Citation[];
  parent_message_id?: UUID;
  retry_of_message_id?: UUID;
  created_at: string;
  completed_at?: string;
}

export interface CreateConversationRequest {
  kb_ids: UUID[];
  title?: string;
}

export interface SendMessageRequest {
  content: string;
  kb_ids?: UUID[];
  client_request_id?: string;
  stream?: boolean;
}

export interface RetryMessageRequest {
  stream?: boolean;
}

export interface SubmitFeedbackRequest {
  rating: Rating;
  reason?: FeedbackReason;
  comment?: string;
  correction?: string;
}

export interface MessageListResponse {
  conversation_id: UUID;
  messages: Message[];
}

export interface FeedbackResponse {
  feedback_id: UUID;
  message_id: UUID;
  created_at: string;
}

export interface SSEEvent {
  event: string;
  data: unknown;
}

export interface AnswerDeltaData {
  message_id: UUID;
  text: string;
}

export interface CitationDeltaData {
  message_id: UUID;
  citation: Citation;
}

export interface AnswerCompletedData {
  message_id: UUID;
  confidence: Confidence;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface AnswerFailedData {
  message_id: UUID;
  code: string;
  message: string;
}

export interface MessageCreatedData {
  user_message_id: UUID;
  assistant_message_id: UUID;
}
