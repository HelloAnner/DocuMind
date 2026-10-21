export type UserFileSource = 'upload' | 'sandbox';

// personal：仅上传者本人可见。
// space   ：当前企业空间（tenant）内全体成员可见。
export type FileScope = 'personal' | 'space';

export interface UserFile {
  id: string;
  scope: FileScope;
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
