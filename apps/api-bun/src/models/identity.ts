// 移植自 apps/api-rs/src/models/identity.rs
export interface CurrentActor {
  user_id: string;
  tenant_id: string;
  login_id: string;
  email: string;
  name: string;
  scope: string;
  roles: string[];
  permissions: string[];
  allowed_kb_ids: string[];
  is_super_admin: boolean;
  api_client_id: string | null;
  api_token_id: string | null;
  api_scopes: string[];
  api_token_expires_at: string | null;
}
export type ActorScope = CurrentActor;

export function actorHasRole(actor: CurrentActor, role: string): boolean {
  return actor.roles.includes(role);
}
export function actorHasPermission(actor: CurrentActor, permission: string): boolean {
  return actor.permissions.includes(permission);
}
export function actorCanManageKb(actor: CurrentActor, kbId: string): boolean {
  return actor.allowed_kb_ids.includes(kbId);
}

export interface UserProfile {
  id: string; login_id: string; email: string; name: string | null;
  avatar_url: string | null; status: string;
}
export interface TenantProfile {
  id: string; name: string; slug: string; plan: string; status: string;
}
export interface MeResponse {
  scope: string; user: UserProfile; tenant: TenantProfile;
  roles: string[]; permissions: string[]; allowed_kb_ids: string[];
}
export interface TenantSummary {
  id: string; name: string; slug: string; status: string; plan: string;
  member_count: number; kb_count: number; doc_count: number; monthly_queries: number;
  active_admin_count: number; pending_invitation_count: number; updated_at: string;
}
export interface SystemUserSummary {
  id: string; login_id: string; email: string; name: string | null; status: string;
  tenants: string[]; last_login_at: string | null;
}
export interface ModelService {
  id: string; name: string; role: string; provider: string; model: string; base_url: string;
  configured: boolean; status: 'healthy' | 'unavailable' | 'disabled';
  latency_ms: number | null; checked_at: string; reason: string | null;
}
export interface JobSummary {
  id: string; tenant_id: string; tenant_name: string; kind: string; title: string;
  status: 'queued' | 'running'; progress: number | null; queue_position: number | null;
  attempt_count: number; max_attempts: number; worker_id: string | null;
  created_at: string; started_at: string | null; updated_at: string;
}
export interface KnowledgeBaseSummary {
  id: string; tenant_id: string; name: string; description: string | null; status: string;
  tags: string[]; doc_count: number; chunk_count: number; query_count: number; updated_at: string;
}
export interface MemberSummary {
  id: string; email: string; name: string | null; roles: string[];
  allowed_kb_names: string[]; query_count: number; status: string;
  joined_at: string | null; last_seen_at: string | null;
}
export interface QaLogSummary {
  id: string; question: string; kb_name: string; user_name: string; score: number;
  feedback: string | null; created_at: string;
}
