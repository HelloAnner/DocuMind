import { getAuthHeaders } from "./auth";
import type {
  Conversation,
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

export async function deleteConversation(
  conversationId: string
): Promise<{ conversation_id: string; status: string }> {
  return fetchJson(`/api/conversations/${conversationId}`, { method: "DELETE" });
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

export async function fetchAdminDocumentOriginalBlob(docId: string): Promise<Blob> {
  const response = await fetch(adminDocumentOriginalUrl(docId), {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    throw new Error(`API error ${response.status}: ${text}`);
  }
  return response.blob();
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

export async function uploadAdminDocument(kbId: string, file: File): Promise<AdminDocument> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch(`${BASE}/api/knowledge-bases/${kbId}/documents`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: form,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    throw new Error(`API error ${response.status}: ${text}`);
  }
  const uploaded = (await response.json()) as UploadDocumentResponse;
  const detail = await getAdminDocument(uploaded.document_id);
  return detail.document;
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
