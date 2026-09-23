export type UserFileSource = 'upload' | 'sandbox';

export interface UserFile {
  id: string;
  name: string;
  path: string;
  mime_type: string;
  size_bytes: number;
  source: UserFileSource;
  conversation_id?: string;
  created_at: string;
  updated_at: string;
  download_url: string;
}

export interface StoredUserFile extends UserFile {
  tenant_id: string;
  user_id: string;
  storage_key: string;
  extracted_text: string | null;
  extraction_truncated: boolean;
}
