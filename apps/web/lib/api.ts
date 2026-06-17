import { getAuthHeaders } from "./auth";
import type {
  Conversation,
  CreateConversationRequest,
  FeedbackResponse,
  Message,
  MessageListResponse,
  SendMessageRequest,
  SubmitFeedbackRequest,
} from "./types";

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${input}`, {
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    ...init,
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

export interface AdminDocumentDetail {
  document: AdminDocument;
  latest_job?: ParseJobSummary;
  blocks: DocumentBlock[];
  chunks: DocumentChunk[];
  tables: DocumentTable[];
}

export async function listAdminDocuments(params?: {
  kb_id?: string;
  status?: string;
}): Promise<AdminDocument[]> {
  const qs = new URLSearchParams();
  if (params?.kb_id) qs.set("kb_id", params.kb_id);
  if (params?.status) qs.set("status", params.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return fetchJson(`/api/admin/documents${suffix}`);
}

export async function getAdminDocument(docId: string): Promise<AdminDocumentDetail> {
  return fetchJson(`/api/admin/documents/${docId}`);
}

export async function retryAdminDocument(docId: string): Promise<AdminDocument> {
  return fetchJson(`/api/admin/documents/${docId}/retry`, { method: "POST" });
}

export async function uploadAdminDocument(kbId: string, file: File): Promise<AdminDocument> {
  const form = new FormData();
  form.set("kb_id", kbId);
  form.set("file", file);
  const response = await fetch(`${BASE}/api/admin/documents`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: form,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    throw new Error(`API error ${response.status}: ${text}`);
  }
  return response.json() as Promise<AdminDocument>;
}
