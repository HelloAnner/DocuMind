export type JsonObject = Record<string, unknown>;

export interface ServerConfig {
  url: string;
  base_path: string;
  timeout_seconds: number;
}

export interface AuthConfig {
  username: string;
  password: string;
  password_env: string;
  tenant: string;
}

export interface ChatConfig {
  kb_ids: string[];
  trace: "off" | "summary" | "full";
  stream: boolean;
}

export interface DiagnosticsConfig {
  ssh_host: string;
  elasticsearch_url: string;
  elasticsearch_index: string;
}

export interface CliConfig {
  version: number;
  server: ServerConfig;
  auth: AuthConfig;
  chat: ChatConfig;
  diagnostics: DiagnosticsConfig;
}

export interface UserProfile {
  id: string;
  email: string;
  name?: string | null;
  avatar_url?: string | null;
  status: string;
}

export interface TenantProfile {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
}

export interface Identity {
  user: UserProfile;
  tenant: TenantProfile;
  roles: string[];
  permissions: string[];
  allowed_kb_ids: string[];
}

export interface LoginResponse extends Identity {
  access_token: string;
  token_type: string;
}

export interface SessionState extends Partial<Identity> {
  access_token?: string;
  last_conversation_id?: string;
  saved_at?: string;
}

export interface KnowledgeBase {
  id: string;
  tenant_id: string;
  name: string;
  description?: string | null;
  status: string;
  tags: string[];
  doc_count: number;
  chunk_count: number;
  query_count: number;
  updated_at: string;
}

export interface ConversationSummary {
  conversation_id: string;
  title: string;
  kb_ids?: string[];
  last_message_preview?: string;
  created_at?: string;
  updated_at: string;
}

export interface CitationAnchor {
  anchor_id?: string;
  parse_job_id?: string;
  format?: string;
  kind?: string;
  page?: number;
  slide?: number;
  block_ids?: string[];
  table_ids?: string[];
  char_range?: { start: number; end: number };
  bbox?: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    unit?: string;
    rotation?: number;
  };
  location_status?: string;
}

export interface Citation {
  index: number;
  doc_id: string;
  chunk_id: string;
  doc_title: string;
  page_range: number[];
  quote: string;
  score?: number;
  source_status?: string;
  anchor?: CitationAnchor;
}

export interface Message {
  message_id: string;
  role: "user" | "assistant";
  content: string;
  status: "created" | "answering" | "completed" | "failed" | "cancelled";
  confidence?: "high" | "medium" | "low";
  no_answer_reason?: string;
  agent_mode?: string;
  prompt_versions?: Record<string, string>;
  citations: Citation[];
  parent_message_id?: string;
  retry_of_message_id?: string;
  created_at: string;
  completed_at?: string;
}

export interface MessageListResponse {
  conversation_id: string;
  messages: Message[];
}

export interface ResolvedRef {
  text: string;
  resolved_to: string;
  source_message_id?: string;
  evidence_message_id?: string;
}

export interface QueryTrace {
  id: string;
  message_id: string;
  original_query: string;
  rewritten_query?: string | null;
  keywords: string[];
  hypothetical_answer?: string | null;
  resolved_refs: ResolvedRef[];
  effective_kb_ids: string[];
  rewrite_model: string;
  created_at: string;
}

export interface RetrievalTrace {
  id: string;
  message_id: string;
  chunk_id: string;
  doc_id: string;
  source: "dense" | "bm25" | "rrf" | "rerank";
  rank: number;
  score: number;
  heading_path: string[];
  page_range: number[];
  content_preview: string;
}

export interface AgentTrace {
  mode: string;
  mode_reason: string;
  rewritten_query?: string | null;
  keywords: string[];
  resolved_refs: ResolvedRef[];
  retrieval_plan: {
    mode: string;
    queries: Array<{ query: string; reason: string }>;
  };
  prompt_versions: Record<string, string>;
  model: string;
  usage?: { input_tokens: number; output_tokens: number } | null;
  started_at: string;
}

export interface MessageTraceResponse {
  message_id: string;
  agent_trace?: AgentTrace | null;
  query_trace?: QueryTrace | null;
  retrieval_traces: RetrievalTrace[];
}

export interface RuntimeStep {
  step_id: string;
  parent_step_id?: string | null;
  step_type: string;
  name: string;
}

export interface RuntimeEventEnvelope {
  schema_version: string;
  event_id: string;
  job_id: string;
  tenant_id: string;
  user_id: string;
  agent_id: string;
  session_id: string;
  execution_id: string;
  event_seq: number;
  event_type: string;
  occurred_at: string;
  response_message_id: string;
  trace_id: string;
  step?: RuntimeStep | null;
  payload: JsonObject;
}

export interface SseFrame {
  event: string;
  id?: string;
  data: unknown;
}

export interface ObservedEvent extends SseFrame {
  received_at: string;
  elapsed_ms: number;
  envelope?: RuntimeEventEnvelope;
}

export interface ExecutionRound {
  round: number;
  tool_call_id: string;
  name: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  arguments?: unknown;
  result?: unknown;
}

export interface ChatRequest {
  content: string;
  conversation_id?: string;
  kb_ids?: string[];
  title?: string;
  client_request_id?: string;
}

export interface ChatRunReport {
  schema_version: "documind.cli.chat.v1";
  server: string;
  identity: {
    user_id: string;
    username: string;
    tenant_id: string;
    tenant: string;
  };
  request: {
    conversation_id: string;
    content: string;
    kb_ids: string[];
    client_request_id: string;
  };
  response: {
    user_message_id?: string;
    assistant_message_id: string;
    content: string;
    status: string;
    confidence?: string;
    no_answer_reason?: string;
  };
  timing: {
    total_ms: number;
    time_to_first_event_ms?: number;
    time_to_first_token_ms?: number;
    persisted_duration_ms?: number;
  };
  execution: {
    job_id?: string;
    execution_id?: string;
    trace_id?: string;
    round_source: "agent_iterations" | "runtime_tool_events";
    react_round_count: number;
    react_rounds: ExecutionRound[];
    usage?: JsonObject;
  };
  citations: Citation[];
  trace: MessageTraceResponse;
  events: ObservedEvent[];
}

export interface AdminDocument {
  doc_id: string;
  kb_id: string;
  kb_name: string;
  title: string;
  file_name: string;
  file_type: string;
  mime_type: string;
  file_size: number;
  file_sha256: string;
  parse_status: string;
  parse_version: number;
  latest_parse_job_id?: string;
  quality_score?: number;
  chunk_count: number;
  table_count: number;
  page_count?: number;
  uploaded_at: string;
  updated_at: string;
}

export interface DocumentChunk {
  chunk_id: string;
  chunk_index: number;
  source_type: string;
  content: string;
  heading_path: string[];
  page_start?: number;
  page_end?: number;
  slide_start?: number;
  slide_end?: number;
  token_count: number;
}

export interface AdminDocumentDetail {
  document: AdminDocument;
  latest_job?: JsonObject | null;
  preview: JsonObject;
  blocks: JsonObject[];
  cleaned_blocks: JsonObject[];
  chunks: DocumentChunk[];
  tables: JsonObject[];
}

export interface VectorIndexSummary {
  id: string;
  name: string;
  alias: string;
  tenant_id: string;
  tenant: string;
  kb_id: string;
  kb_name: string;
  embedding_model: string;
  index_version: string;
  dimension: number;
  documents: number;
  building_documents: number;
  degraded_documents: number;
  chunks: number;
  embedded_chunks: number;
  es_documents: number;
  status: string;
  lastIndexed?: string;
}

export interface ScenarioExpectation {
  status?: string;
  confidence?: string | string[];
  citations_min?: number;
  retrievals_min?: number;
  react_rounds_min?: number;
  contains?: string | string[];
  not_contains?: string | string[];
  max_duration_ms?: number;
}

export interface ScenarioTurn {
  content: string;
  kb_ids?: string[];
  expect?: ScenarioExpectation;
}

export interface Scenario {
  name?: string;
  conversation?: {
    id?: string;
    title?: string;
    kb_ids?: string[];
  };
  turns: ScenarioTurn[];
}

export interface AssertionResult {
  field: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}

export interface ScenarioReport {
  schema_version: "documind.cli.scenario.v1";
  name: string;
  conversation_id: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  passed: boolean;
  turns: Array<{
    report: ChatRunReport;
    assertions: AssertionResult[];
    passed: boolean;
  }>;
}
