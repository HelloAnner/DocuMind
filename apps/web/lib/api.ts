import { getAuthHeaders } from "./auth";
import type {
  Conversation,
  ConversationFileListResponse,
  CreateConversationRequest,
  FeedbackResponse,
  MessageTraceResponse,
  Message,
  MessageListResponse,
  SendMessageRequest,
  SubmitFeedbackRequest,
} from "./types";

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const headers =
    init?.body instanceof FormData
      ? { ...getAuthHeaders(), ...(init.headers ?? {}) }
      : { "Content-Type": "application/json", ...getAuthHeaders(), ...(init?.headers ?? {}) };

  const response = await fetch(`${BASE}${input}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    throw new Error(`API error ${response.status}: ${text}`);
  }
  return response.json() as Promise<T>;
}

export async function listConversations(
  limit = 20,
  cursor?: string
): Promise<{ items: Conversation[]; next_cursor?: string }> {
  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  if (cursor) qs.set("cursor", cursor);
  return fetchJson(`/api/conversations?${qs.toString()}`);
}

export async function createConversation(
  req: CreateConversationRequest
): Promise<Conversation> {
  return fetchJson("/api/conversations", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function getMessages(conversationId: string): Promise<MessageListResponse> {
  return fetchJson(`/api/conversations/${conversationId}/messages`);
}

export async function getConversationFiles(
  conversationId: string
): Promise<ConversationFileListResponse> {
  return fetchJson(`/api/conversations/${conversationId}/files`);
}

export async function deleteConversation(
  conversationId: string
): Promise<{ conversation_id: string; status: string }> {
  return fetchJson(`/api/conversations/${conversationId}`, { method: "DELETE" });
}

export async function renameConversation(
  conversationId: string,
  title: string
): Promise<{ conversation_id: string; title: string }> {
  return fetchJson(`/api/conversations/${conversationId}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export async function getMessageTraces(
  conversationId: string,
  messageId: string
): Promise<MessageTraceResponse> {
  return fetchJson(`/api/conversations/${conversationId}/messages/${messageId}/traces`);
}

export function sendMessageStreamUrl(conversationId: string): string {
  return `${BASE}/api/conversations/${conversationId}/messages`;
}

export { type SendMessageRequest };

export async function cancelMessage(
  conversationId: string,
  messageId: string
): Promise<{ message_id: string; status: string }> {
  return fetchJson(`/api/conversations/${conversationId}/messages/${messageId}/cancel`, {
    method: "POST",
  });
}

export function retryMessageStreamUrl(
  conversationId: string,
  messageId: string
): string {
  return `${BASE}/api/conversations/${conversationId}/messages/${messageId}/retry`;
}

export async function submitFeedback(
  conversationId: string,
  messageId: string,
  req: SubmitFeedbackRequest
): Promise<FeedbackResponse> {
  return fetchJson(`/api/conversations/${conversationId}/messages/${messageId}/feedback`, {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function deleteFeedback(
  conversationId: string,
  messageId: string
): Promise<{ message_id: string }> {
  return fetchJson(`/api/conversations/${conversationId}/messages/${messageId}/feedback`, {
    method: "DELETE",
  });
}

export interface KnowledgeBase {
  id: string;
  tenant_id: string;
  name: string;
  description?: string;
  status: string;
  tags: string[];
  doc_count: number;
  chunk_count: number;
  query_count: number;
  updated_at: string;
}

export async function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  return fetchJson("/api/knowledge-bases");
}

export async function listAdminKnowledgeBases(): Promise<KnowledgeBase[]> {
  return fetchJson("/api/admin/knowledge-bases");
}

export interface KnowledgeBaseUpsert {
  name: string;
  description?: string;
  status?: string;
  tags?: string[];
}

export async function createKnowledgeBase(req: KnowledgeBaseUpsert): Promise<KnowledgeBase> {
  return fetchJson("/api/admin/knowledge-bases", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function updateKnowledgeBase(kbId: string, req: KnowledgeBaseUpsert): Promise<KnowledgeBase> {
  return fetchJson(`/api/admin/knowledge-bases/${kbId}`, {
    method: "PUT",
    body: JSON.stringify(req),
  });
}

export async function deleteKnowledgeBase(kbId: string): Promise<{ kb_id: string; status: string }> {
  return fetchJson(`/api/admin/knowledge-bases/${kbId}`, { method: "DELETE" });
}

export interface AdminMember {
  id: string;
  email: string;
  name?: string;
  roles: string[];
  allowed_kb_names: string[];
  query_count: number;
  status: string;
  joined_at?: string;
  last_seen_at?: string;
}

export async function listAdminMembers(): Promise<AdminMember[]> {
  return fetchJson("/api/admin/members");
}

export async function updateAdminMember(
  userId: string,
  input: { role?: "tenant_admin" | "end_user"; status?: "active" | "suspended" }
): Promise<{ user_id: string; roles: string[]; status: string }> {
  return fetchJson(`/api/admin/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function removeAdminMember(userId: string): Promise<{ user_id: string; status: string }> {
  return fetchJson(`/api/admin/members/${userId}`, { method: "DELETE" });
}

export interface SystemTenant {
  id: string;
  name: string;
  slug: string;
  status: "pending" | "active" | "suspended" | "archived" | "deletion_pending";
  plan: "trial" | "team" | "enterprise";
  member_count: number;
  kb_count: number;
  doc_count: number;
  monthly_queries: number;
  active_admin_count: number;
  pending_invitation_count: number;
  updated_at: string;
}

export interface CreateSystemTenantRequest {
  name: string;
  slug?: string;
  plan: SystemTenant["plan"];
  admin_email: string;
  admin_name?: string;
  expires_in_days: number;
}

export interface CreateSystemTenantResponse {
  tenant: Pick<SystemTenant, "id" | "name" | "slug" | "plan" | "status">;
  invitation: {
    id: string;
    email: string;
    roles: string[];
    status: string;
    expires_at: string;
    invite_url: string;
  };
}

export async function listSystemTenants(): Promise<SystemTenant[]> {
  return fetchJson("/api/system/tenants");
}

export async function createSystemTenant(input: CreateSystemTenantRequest): Promise<CreateSystemTenantResponse> {
  return fetchJson("/api/system/tenants", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateSystemTenant(
  id: string,
  input: { name?: string; plan?: SystemTenant["plan"]; status?: SystemTenant["status"] }
): Promise<SystemTenant> {
  return fetchJson(`/api/system/tenants/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function requestSystemTenantDeletion(id: string, slug: string) {
  return fetchJson<{ id: string; slug: string; status: "deletion_pending" }>(
    `/api/system/tenants/${id}?confirm_slug=${encodeURIComponent(slug)}`,
    { method: "DELETE" }
  );
}

export async function generateSystemTenantAdminInvitation(id: string, expiresInDays: number, email?: string) {
  return fetchJson<{ id: string; email: string; expires_at: string; invite_url: string }>(
    `/api/system/tenants/${id}/invitations/resend`,
    {
      method: "POST",
      body: JSON.stringify({ expires_in_days: expiresInDays, email }),
    }
  );
}

export interface TenantInvitation {
  id: string;
  tenant_id: string;
  email: string;
  name?: string;
  roles: string[];
  kb_grants: { kb_id: string; permission: KnowledgeBasePermission }[];
  status: string;
  invited_by: string;
  invited_by_label?: string;
  accepted_by?: string;
  expires_at: string;
  accepted_at?: string;
  revoked_at?: string;
  created_at: string;
  invite_url?: string;
}

export interface CreateTenantInvitationRequest {
  email: string;
  name?: string;
  roles: string[];
  kb_grants?: { kb_id: string; permission: KnowledgeBasePermission }[];
  expires_in_days?: number;
}

export async function listTenantInvitations(): Promise<TenantInvitation[]> {
  return fetchJson("/api/admin/invitations");
}

export async function createTenantInvitation(
  req: CreateTenantInvitationRequest
): Promise<TenantInvitation> {
  return fetchJson("/api/admin/invitations", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function resendTenantInvitation(id: string): Promise<TenantInvitation> {
  return fetchJson(`/api/admin/invitations/${id}/resend`, { method: "POST" });
}

export async function revokeTenantInvitation(id: string): Promise<TenantInvitation> {
  return fetchJson(`/api/admin/invitations/${id}/revoke`, { method: "POST" });
}

export type PermissionSubjectType = "role" | "user";
export type KnowledgeBasePermission = "read" | "write" | "manage";

export interface KnowledgeBaseAuthorization {
  id: string;
  tenant_id: string;
  kb_id: string;
  kb_name: string;
  subject_type: PermissionSubjectType;
  subject_id: string;
  subject_label: string;
  permission: KnowledgeBasePermission;
  created_by?: string;
  created_by_label?: string;
  created_at: string;
}

export interface GrantKnowledgeBasePermissionRequest {
  kb_id: string;
  subject_type: PermissionSubjectType;
  subject_id: string;
  permission: KnowledgeBasePermission;
}

export async function listAdminPermissions(): Promise<KnowledgeBaseAuthorization[]> {
  return fetchJson("/api/admin/permissions");
}

export async function grantKnowledgeBasePermission(
  req: GrantKnowledgeBasePermissionRequest
): Promise<KnowledgeBaseAuthorization> {
  return fetchJson("/api/admin/permissions", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function revokeKnowledgeBasePermission(id: string): Promise<{ id: string; status: string }> {
  return fetchJson(`/api/admin/permissions/${id}`, { method: "DELETE" });
}

export interface ApiTokenSummary {
  id: string;
  token_prefix: string;
  status: "active" | "revoked";
  expires_at: string;
  last_used_at?: string;
  created_at: string;
}

export interface ApiClientSummary {
  id: string;
  name: string;
  description?: string;
  scopes: string[];
  status: "active" | "disabled";
  rate_limit_per_minute: number;
  kb_ids: string[];
  tokens: ApiTokenSummary[];
  created_at: string;
}

export interface CreatedApiClient {
  client: ApiClientSummary;
  token: string;
}

export async function listApiClients(): Promise<ApiClientSummary[]> {
  return fetchJson("/api/admin/api-clients");
}

export async function createApiClient(input: {
  name: string;
  description?: string;
  kb_ids: string[];
  expires_in_days: number;
  rate_limit_per_minute: number;
}): Promise<CreatedApiClient> {
  return fetchJson("/api/admin/api-clients", { method: "POST", body: JSON.stringify(input) });
}

export async function createApiClientToken(clientId: string, expiresInDays = 90): Promise<{ token: ApiTokenSummary; secret: string }> {
  return fetchJson(`/api/admin/api-clients/${clientId}/tokens`, {
    method: "POST",
    body: JSON.stringify({ expires_in_days: expiresInDays }),
  });
}

export async function revokeApiClientToken(clientId: string, tokenId: string): Promise<void> {
  await fetchJson(`/api/admin/api-clients/${clientId}/tokens/${tokenId}/revoke`, { method: "POST" });
}

export async function updateApiClientStatus(clientId: string, status: "active" | "disabled"): Promise<ApiClientSummary> {
  return fetchJson(`/api/admin/api-clients/${clientId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export interface AdminRuntimeConfig {
  read_only: boolean;
  source: string;
  environment: string;
  chunking: {
    strategy: string;
    chunker_version: string;
    target_chunk_tokens: number;
    max_chunk_tokens: number;
    hard_split_tokens: number;
    min_chunk_tokens: number;
    overlap_tokens: number;
    max_table_rows_per_chunk: number;
    max_table_token_per_chunk: number;
    preserve_table_structure: boolean;
    preserve_list_hierarchy: boolean;
    merge_short_blocks: boolean;
  };
  embedding: {
    enabled: boolean;
    model: string;
    base_url: string;
    api_key_configured: boolean;
    batch_size: number;
    index_name: string;
    index_alias: string;
  };
  search: {
    strategy: string;
    dense_top_k: number;
    bm25_top_k: number;
    rrf_top_k: number;
    effective_top_k: number;
    rerank_enabled: boolean;
    rerank_model: string;
    rerank_api_configured: boolean;
    rerank_min_score: number;
  };
  llm: {
    provider: string;
    use_real_llm: boolean;
    model: string;
    base_url: string;
    api_key_configured: boolean;
    temperature: number;
    max_output_tokens: number;
    streaming_enabled: boolean;
    rewrite_enabled: boolean;
    rewrite_model: string;
  };
}

export async function getAdminRuntimeConfig(): Promise<AdminRuntimeConfig> {
  return fetchJson("/api/admin/runtime-config");
}

export interface SystemVectorIndex {
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
  status: "healthy" | "building" | "degraded";
  lastIndexed?: string;
}

export async function listSystemVectorIndexes(): Promise<SystemVectorIndex[]> {
  return fetchJson("/api/system/vector-indexes");
}

export interface SystemSettingsSnapshot {
  read_only: boolean;
  environment: string;
  service: {
    host: string;
    port: number;
    base_path: string;
    health_path: string;
  };
  auth: {
    login_mode: string;
    token_expire_hours: number;
    portal_base_url: string;
    portal_exchange_endpoint: string;
    local_login_enabled: boolean;
    portal_login_enabled: boolean;
  };
  storage: {
    database_configured: boolean;
    redis_configured: boolean;
    rabbitmq_configured: boolean;
    elasticsearch_configured: boolean;
    object_storage_provider: string;
    object_storage_endpoint_configured: boolean;
    object_storage_region: string;
    object_storage_bucket: string;
    object_storage_force_path_style: boolean;
    object_storage_tls_verify: boolean;
    object_storage_presign_expire_seconds: number;
  };
  deployment: {
    host_alias: string;
    root: string;
    current: string;
    releases: string;
    shared: string;
    env_file: string;
    log_file: string;
    containers: string[];
  };
}

export async function getSystemSettings(): Promise<SystemSettingsSnapshot> {
  return fetchJson("/api/system/settings");
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

export interface ParseJobSummary {
  parse_job_id: string;
  status: string;
  parser_version: string;
  quality_score?: number;
  page_count?: number;
  block_count?: number;
  table_count?: number;
  char_count?: number;
  warnings: unknown;
  error_code?: string;
  error_message?: string;
  started_at?: string;
  finished_at?: string;
  created_at: string;
}

export interface DocumentBlock {
  block_id: string;
  block_index: number;
  block_type: string;
  text: string;
  heading_level?: number;
  heading_path: string[];
  page_start?: number;
  page_end?: number;
  slide_index?: number;
  table_id?: string;
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

export interface CleanedDocumentBlock {
  block_id: string;
  block_index: number;
  block_type: string;
  cleaned_text: string;
  is_removed: boolean;
  remove_reason?: string;
  cleaning_ops: string[];
  heading_path: string[];
}

export interface DocumentTable {
  table_id: string;
  table_index: number;
  title?: string;
  row_count: number;
  col_count: number;
  headers: string[];
  markdown: string;
  quality: unknown;
}

export interface DocumentPreview {
  mode: "parsed_text" | "pending" | "failed" | string;
  title: string;
  text: string;
  truncated: boolean;
  source: string;
  char_count: number;
}

export interface FilePreviewManifestPage {
  page: number;
  width: number;
  height: number;
  rotation: number;
  text_layer_available: boolean;
}

export interface FilePreviewManifest {
  doc_id: string;
  parse_job_id?: string;
  file_name: string;
  format: string;
  preview_type: string;
  page_count?: number;
  pages: FilePreviewManifestPage[];
  text_layer_available: boolean;
  conversion_status: string;
}

export interface FilePreviewResponse {
  doc_id: string;
  parse_job_id?: string;
  file_name: string;
  format: string;
  preview_type: string;
  preview_url: string;
  manifest_url: string;
  source_status: string;
}

export interface FilePreviewUrlResponse {
  doc_id: string;
  parse_job_id?: string;
  file_name: string;
  format: string;
  preview_type: string;
  expires_at: string;
  expires_in_seconds: number;
  preview_url: string;
  manifest_url: string;
  page_pdf_url_template: string;
}

export interface AdminDocumentDetail {
  document: AdminDocument;
  latest_job?: ParseJobSummary;
  preview: DocumentPreview;
  blocks: DocumentBlock[];
  cleaned_blocks: CleanedDocumentBlock[];
  chunks: DocumentChunk[];
  tables: DocumentTable[];
}

export async function listAdminDocuments(params?: {
  kb_id?: string;
  status?: string;
  q?: string;
  limit?: number;
}): Promise<AdminDocument[]> {
  const qs = new URLSearchParams();
  if (params?.kb_id) qs.set("kb_id", params.kb_id);
  if (params?.status) qs.set("status", params.status);
  if (params?.q) qs.set("q", params.q);
  if (params?.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return fetchJson(`/api/admin/documents${suffix}`);
}

export async function getAdminDocument(docId: string): Promise<AdminDocumentDetail> {
  return fetchJson(`/api/admin/documents/${docId}`);
}

export async function retryAdminDocument(docId: string): Promise<AdminDocument> {
  return fetchJson(`/api/admin/documents/${docId}/retry`, { method: "POST" });
}

export interface ReprocessDocumentResponse {
  document_id: string;
  parse_job_id: string;
  parse_status: string;
  parse_version: number;
  block_count: number;
  table_count: number;
  chunk_count: number;
  reused_existing_parse: boolean;
}

export interface ExcludeFromSearchResponse {
  document_id: string;
  status: string;
  es_deleted_chunks: number;
}

export interface SendToOcrResponse {
  document_id: string;
  ocr_job_id: string;
  parse_status: string;
  ocr_status: string;
}

export interface ReplaceDocumentFileResponse {
  document_id: string;
  parse_job_id: string;
  parse_status: string;
  parse_version: number;
  title: string;
  file_type: string;
  file_sha256: string;
  storage_key: string;
}

export async function forceIndexAdminDocument(docId: string): Promise<ReprocessDocumentResponse> {
  return fetchJson(`/api/admin/documents/${docId}/force-index`, { method: "POST" });
}

export async function excludeAdminDocumentFromSearch(docId: string): Promise<ExcludeFromSearchResponse> {
  return fetchJson(`/api/admin/documents/${docId}/exclude-from-search`, { method: "POST" });
}

export async function sendAdminDocumentToOcr(docId: string): Promise<SendToOcrResponse> {
  return fetchJson(`/api/admin/documents/${docId}/send-to-ocr`, { method: "POST" });
}

export async function retryAdminDocuments(docIds: string[]): Promise<{ retried: number }> {
  return fetchJson("/api/admin/documents/retry", {
    method: "POST",
    body: JSON.stringify({ doc_ids: docIds }),
  });
}

export async function deleteAdminDocument(docId: string): Promise<{ doc_id: string; status: string }> {
  return fetchJson(`/api/admin/documents/${docId}`, { method: "DELETE" });
}

export async function moveAdminDocument(docId: string, kbId: string): Promise<AdminDocument> {
  return fetchJson(`/api/admin/documents/${docId}/move`, {
    method: "POST",
    body: JSON.stringify({ kb_id: kbId }),
  });
}

export function adminDocumentOriginalUrl(docId: string): string {
  return `${BASE}/api/admin/documents/${docId}/original`;
}

export function adminDocumentPagePdfUrl(docId: string, page: number): string {
  return `${BASE}/api/admin/documents/${docId}/pages/${page}/pdf`;
}

function withConversationContext(path: string, conversationId?: string): string {
  if (!conversationId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}conversation_id=${encodeURIComponent(conversationId)}`;
}

export function filePreviewPagePdfUrl(
  docId: string,
  page: number,
  conversationId?: string
): string {
  return withConversationContext(
    `${BASE}/api/files/${docId}/preview/pages/${page}/pdf`,
    conversationId
  );
}

export function filePreviewContentUrl(docId: string, conversationId?: string): string {
  return withConversationContext(`${BASE}/api/files/${docId}/preview/content`, conversationId);
}

export async function getFilePreview(
  docId: string,
  conversationId?: string
): Promise<FilePreviewResponse> {
  return fetchJson(
    withConversationContext(`/api/files/${docId}/preview`, conversationId)
  );
}

export async function getFilePreviewUrl(
  docId: string,
  conversationId?: string
): Promise<FilePreviewUrlResponse> {
  return fetchJson(
    withConversationContext(`/api/files/${docId}/preview-url`, conversationId)
  );
}

export async function getFilePreviewManifest(
  docId: string,
  conversationId?: string
): Promise<FilePreviewManifest> {
  return fetchJson(
    withConversationContext(`/api/files/${docId}/preview/manifest`, conversationId)
  );
}

const originalBlobCache = new Map<string, Promise<Blob>>();
const filePreviewBlobCache = new Map<string, Promise<Blob>>();

export async function fetchAdminDocumentOriginalBlob(docId: string): Promise<Blob> {
  const cached = originalBlobCache.get(docId);
  if (cached) return cached;

  const promise = (async () => {
    const response = await fetch(adminDocumentOriginalUrl(docId), {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "Unknown error");
      throw new Error(`API error ${response.status}: ${text}`);
    }
    return response.blob();
  })();

  originalBlobCache.set(docId, promise);
  promise.catch(() => {
    originalBlobCache.delete(docId);
  });

  return promise;
}

export async function fetchFilePreviewBlob(
  docId: string,
  conversationId?: string
): Promise<Blob> {
  const cacheKey = `${conversationId ?? "direct"}:${docId}`;
  const cached = filePreviewBlobCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const response = await fetch(filePreviewContentUrl(docId, conversationId), {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "Unknown error");
      throw new Error(`API error ${response.status}: ${text}`);
    }
    return response.blob();
  })();

  filePreviewBlobCache.set(cacheKey, promise);
  promise.catch(() => {
    filePreviewBlobCache.delete(cacheKey);
  });

  return promise;
}

export async function downloadAdminDocumentOriginal(docId: string, fileName: string): Promise<void> {
  const blob = await fetchAdminDocumentOriginalBlob(docId);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export interface DocumentJob {
  job_id: string;
  doc_id: string;
  upload_batch_id?: string;
  kb_id: string;
  kb_name: string;
  file_name: string;
  file_type: string;
  file_size: number;
  uploaded_by?: string;
  parse_status: string;
  job_status: "queued" | "processing" | "completed" | "warning" | "failed";
  current_stage: string;
  queue_position?: number;
  stalled: boolean;
  attempt_count: number;
  max_attempts: number;
  quality_score?: number;
  page_count?: number;
  block_count?: number;
  table_count?: number;
  chunk_count: number;
  error_code?: string;
  error_message?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  updated_at: string;
}

export interface DocumentJobEvent {
  id: string;
  stage: string;
  status: "queued" | "running" | "completed" | "failed" | "warning";
  message: string;
  metrics: Record<string, unknown>;
  error_code?: string;
  error_message?: string;
  created_at: string;
}

export interface DocumentJobsResponse {
  items: DocumentJob[];
  summary: { queued: number; processing: number; failed_24h: number; completed_24h: number; stalled: number };
}

export interface DocumentJobDetail {
  job: DocumentJob;
  events: DocumentJobEvent[];
  vector_job?: {
    id: string;
    status: string;
    attempt_count: number;
    max_attempts: number;
    error_message?: string;
    available_at: string;
    started_at?: string;
    completed_at?: string;
  };
}

export async function listDocumentJobs(params?: { status?: string; kb_id?: string; batch_id?: string; q?: string; limit?: number }): Promise<DocumentJobsResponse> {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.kb_id) query.set("kb_id", params.kb_id);
  if (params?.batch_id) query.set("batch_id", params.batch_id);
  if (params?.q) query.set("q", params.q);
  if (params?.limit) query.set("limit", String(params.limit));
  return fetchJson(`/api/admin/document-jobs${query.size ? `?${query}` : ""}`);
}

export async function getDocumentJob(jobId: string): Promise<DocumentJobDetail> {
  return fetchJson(`/api/admin/document-jobs/${encodeURIComponent(jobId)}`);
}

export interface DocumentUploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export function uploadAdminDocumentWithProgress(
  kbId: string,
  file: File,
  onProgress: (progress: DocumentUploadProgress) => void,
  signal?: AbortSignal,
  uploadBatchId?: string
): Promise<UploadDocumentResponse> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    if (uploadBatchId) form.set("upload_batch_id", uploadBatchId);
    form.set("file", file);
    const request = new XMLHttpRequest();
    const abortRequest = () => request.abort();
    const cleanup = () => signal?.removeEventListener("abort", abortRequest);

    request.open("POST", `${BASE}/api/knowledge-bases/${kbId}/documents`);
    Object.entries(getAuthHeaders()).forEach(([name, value]) => request.setRequestHeader(name, value));

    request.upload.addEventListener("progress", (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : file.size;
      const loaded = Math.min(event.loaded, total);
      const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
      onProgress({ loaded, total, percent });
    });

    request.addEventListener("load", () => {
      cleanup();
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`API error ${request.status}: ${request.responseText || "上传失败"}`));
        return;
      }
      try {
        resolve(JSON.parse(request.responseText) as UploadDocumentResponse);
      } catch {
        reject(new Error("上传响应格式无效"));
      }
    });
    request.addEventListener("error", () => {
      cleanup();
      reject(new Error("网络连接异常，文件上传失败"));
    });
    request.addEventListener("abort", () => {
      cleanup();
      reject(new DOMException("上传已取消", "AbortError"));
    });

    if (signal?.aborted) {
      reject(new DOMException("上传已取消", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", abortRequest, { once: true });
    onProgress({ loaded: 0, total: file.size, percent: 0 });
    request.send(form);
  });
}

export async function uploadAdminDocument(kbId: string, file: File): Promise<AdminDocument> {
  const uploaded = await uploadAdminDocumentWithProgress(kbId, file, () => undefined);
  const detail = await getAdminDocument(uploaded.document_id);
  return detail.document;
}

export async function replaceAdminDocumentFile(
  docId: string,
  file: File
): Promise<ReplaceDocumentFileResponse> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch(`${BASE}/api/admin/documents/${docId}/replace-file`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: form,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    throw new Error(`API error ${response.status}: ${text}`);
  }
  return response.json() as Promise<ReplaceDocumentFileResponse>;
}

// Cloud-side aliases for backward compatibility
export interface UploadDocumentResponse {
  document_id: string;
  parse_job_id: string;
  title: string;
  file_type: string;
  parse_status: string;
  block_count: number;
  table_count: number;
  chunk_count: number;
  storage_key: string;
}

export interface ReprocessDocumentResponse {
  document_id: string;
  parse_job_id: string;
  parse_status: string;
  parse_version: number;
  block_count: number;
  table_count: number;
  chunk_count: number;
  reused_existing_parse: boolean;
}

export const uploadDocument = uploadAdminDocument;
export const deleteDocument = deleteAdminDocument;
export const reprocessDocument = retryAdminDocument;
