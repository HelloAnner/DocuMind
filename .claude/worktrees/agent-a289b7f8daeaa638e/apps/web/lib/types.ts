export type UUID = string;

export type MessageRole = "user" | "assistant";
export type MessageStatus = "created" | "answering" | "completed" | "failed" | "cancelled";
export type Confidence = "high" | "medium" | "low";
export type Rating = "up" | "down";
export type AnswerSource = "rag" | "manual_correction";
export type CorrectionMatchType = "exact" | "alias" | "semantic";
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
  kb_ids: UUID[];
  last_message_preview?: string;
  updated_at: string;
}

export interface Citation {
  citation_id: UUID;
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
  anchor_id?: UUID;
  parse_job_id?: UUID;
  format?: string;
  kind?: string;
  page?: number;
  slide?: number;
  block_ids?: UUID[];
  table_ids?: UUID[];
  char_range?: {
    start: number;
    end: number;
  };
  bbox?: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    unit?: string;
    rotation?: number;
  };
  location_status?: "exact" | "structural_only" | "page_only" | "slide_only" | "file_only" | "unavailable" | string;
}

export interface ConversationFile {
  doc_id: UUID;
  doc_title: string;
  file_name: string;
  file_type: string;
  kb_id?: UUID;
  kb_name?: string;
  source_status: "available" | "deleted" | string;
  retrieval_count: number;
  citation_count: number;
  last_used_at: string;
  preview_page_range: number[];
  preview_quote: string;
  preview_anchor?: CitationAnchor;
}

export interface ConversationFileListResponse {
  conversation_id: UUID;
  files: ConversationFile[];
}
export type ChatFileSource = "upload" | "sandbox";

export interface ChatFile {
  id: UUID;
  name: string;
  path: string;
  mime_type: string;
  size_bytes: number;
  source: ChatFileSource;
  conversation_id?: UUID | null;
  created_at: string;
  updated_at: string;
  download_url?: string;
}

export interface ChatFileListResponse {
  files: ChatFile[];
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
  reasoning_steps?: RuntimeReasoningStep[];
  runtime_stage?: string;
  feedback?: FeedbackResponse;
  answer_source?: AnswerSource;
  correction_id?: UUID | null;
  correction_version_id?: UUID | null;
  correction_match_type?: CorrectionMatchType | null;
  correction_match_score?: number | null;
  follow_up_questions?: FollowUpQuestion[];
  files?: ChatFile[];
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
  result?: unknown;
  error?: unknown;
  step?: number;
  progress?: number;
  message?: string;
  display?: unknown;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
}

export interface RuntimeReasoningStep {
  step: number;
  action: string;
  decision_summary: string;
  output?: string;
  tool_calls: RuntimeToolCall[];
  warnings?: string[];
  started_at?: string;
  completed_at?: string;
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
  model_id?: string;
  thinking_enabled?: boolean;
  file_ids?: string[];
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
  rating: Rating;
  reason?: FeedbackReason | null;
  comment?: string | null;
  correction?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeleteFeedbackResponse {
  message_id: UUID;
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
