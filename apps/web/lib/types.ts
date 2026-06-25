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
  score?: number;
  source_status?: "available" | "deleted" | string;
  anchor?: CitationAnchor;
}

export interface CitationAnchor {
  format?: string;
  kind?: string;
  page?: number;
  slide?: number;
  block_ids?: UUID[];
  table_ids?: UUID[];
  location_status?: "exact" | "structural_only" | "page_only" | "slide_only" | "unavailable" | string;
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
  thinking?: string;
  tool_calls?: RuntimeToolCall[];
  follow_up_questions?: FollowUpQuestion[];
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  parent_message_id?: UUID;
  retry_of_message_id?: UUID;
  created_at: string;
  completed_at?: string;
}

export interface RuntimeToolCall {
  id: string;
  name: string;
  arguments?: unknown;
  arguments_preview?: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  result?: string;
  progress?: number;
  message?: string;
  display?: unknown;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
}

export interface FollowUpQuestion {
  id: string;
  text: string;
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

export interface ResolvedRef {
  text: string;
  resolved_to: string;
  source_message_id?: UUID;
  evidence_message_id?: UUID;
}

export interface QueryTrace {
  id: UUID;
  message_id: UUID;
  original_query: string;
  rewritten_query?: string;
  keywords: string[];
  hypothetical_answer?: string;
  resolved_refs: ResolvedRef[];
  effective_kb_ids: UUID[];
  rewrite_model: string;
  created_at: string;
}

export interface RetrievalTrace {
  id: UUID;
  message_id: UUID;
  chunk_id: UUID;
  doc_id: UUID;
  source: "dense" | "bm25" | "rrf" | "rerank";
  rank: number;
  score: number;
  heading_path: string[];
  page_range: number[];
  content_preview: string;
}

export interface RetrievalPlan {
  mode: "single" | "multi" | "single_query" | "multi_query";
  queries: Array<{ query: string; reason: string }>;
}

export interface AgentTrace {
  mode_reason: string;
  rewritten_query?: string;
  keywords: string[];
  resolved_refs: ResolvedRef[];
  retrieval_plan: RetrievalPlan;
  prompt_versions: PromptVersions;
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
  started_at: string;
}

export interface MessageTraceResponse {
  message_id: UUID;
  agent_trace?: AgentTrace | null;
  query_trace?: QueryTrace | null;
  retrieval_traces: RetrievalTrace[];
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

export interface RuntimeEventEnvelope {
  schema_version: "moss.execution.event.v1";
  event_id: string;
  job_id: UUID;
  tenant_id: UUID;
  user_id: UUID;
  agent_id: string;
  session_id: UUID;
  execution_id: UUID;
  event_seq: number;
  event_type: string;
  occurred_at: string;
  response_message_id: UUID;
  trace_id: string;
  step?: {
    step_id: string;
    parent_step_id?: string | null;
    step_type: string;
    name: string;
  } | null;
  payload: Record<string, unknown>;
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
