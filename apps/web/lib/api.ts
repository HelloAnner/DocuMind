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
