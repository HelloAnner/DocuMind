// 移植自 apps/api-rs/src/models/conversation_file.rs
import type { CitationAnchor } from './citation.ts';
import type { UserFile } from './user_file.ts';

export interface ConversationFile {
  doc_id: string; doc_title: string; file_name: string; file_type: string;
  kb_id: string | null; kb_name: string | null; source_status: string;
  retrieval_count: number; citation_count: number; last_used_at: string;
  preview_page_range: number[]; preview_quote: string;
  preview_anchor?: CitationAnchor | null;
}
export interface ConversationFileListResponse {
  conversation_id: string;
  files: ConversationFile[];
  user_files: UserFile[];
}
