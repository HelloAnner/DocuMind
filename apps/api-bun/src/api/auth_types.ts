// api/auth.ts 共享的响应类型（避免循环 import）
import type { TenantProfile, UserProfile } from '../models/identity.ts';

export interface LoginResponse {
  access_token: string; token_type: 'bearer'; scope: string;
  user: UserProfile; tenant: TenantProfile;
  roles: string[]; permissions: string[]; allowed_kb_ids: string[];
}
