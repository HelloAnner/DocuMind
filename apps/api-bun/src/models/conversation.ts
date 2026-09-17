// 移植自 apps/api-rs/src/models/conversation.rs
import type { ConversationStatus } from './index.ts';

export interface ConversationSession {
  id: string; tenant_id: string; user_id: string; title: string; kb_ids: string[];
  status: ConversationStatus; summary: string | null;
  created_at: string; updated_at: string;
}
export interface CreateConversationRequest {
  kb_ids: string[]; title?: string | null;
}
export interface ConversationListItem {
  conversation_id: string; title: string; last_message_preview: string | null; updated_at: string;
}
export interface ConversationListResponse {
  items: ConversationListItem[]; next_cursor: string | null;
}
