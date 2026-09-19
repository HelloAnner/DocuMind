export type UserRole =
  | "super_admin"
  | "enterprise_admin"
  | "team_admin"
  | "data_admin"
  | "tenant_owner"
  | "tenant_admin"
  | "user"
  | "analyst"
  | "end_user"
  | "viewer";

export interface User {
  id: string;
  login_id: string;
  email: string;
  name?: string;
  avatar_url?: string;
  status: string;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  roles?: UserRole[];
}

export type AuthScope = "platform" | "tenant";

export interface MeResponse {
  scope: AuthScope;
  user: User;
  tenant: Tenant | null;
  tenants: Tenant[];
  roles: UserRole[];
  permissions: string[];
  allowed_kb_ids: string[];
}

export interface LoginResponse extends MeResponse {
  access_token: string;
  token_type: "bearer";
}

export type TenantLoginTone = "violet" | "azure" | "jade" | "amber" | "rose";

export interface TenantLoginBranding {
  kicker?: string;
  headline?: string;
  description?: string;
  welcome?: string;
  tone?: TenantLoginTone;
}

export interface TenantLoginContext {
  name: string;
  slug: string;
  branding: TenantLoginBranding;
}

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";
const AUTH_KEY = "documind-auth";
export const TENANT_SWITCH_STORAGE_KEY = "documind:tenant-switch";
export const INVITATION_STORAGE_KEY = "documind:invitation-token";

export const AUTHENTICATED_HOME_PATH = "/chat";


export interface StoredAuth {
  token: string;
  userId: string;
  tenantId: string | null;
  loginId: string;
  email: string;
  scope: AuthScope;
  roles: UserRole[];
}

export function getStoredAuth(): StoredAuth | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? (JSON.parse(raw) as StoredAuth) : null;
  } catch {
    return null;
  }
}

export function setStoredAuth(auth: StoredAuth) {
  if (typeof window === "undefined") return;
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
}

export function clearStoredAuth() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(AUTH_KEY);
}

export function getAuthHeaders(): Record<string, string> {
  const auth = getStoredAuth();
  if (!auth?.token) return {};
  return {
    Authorization: `Bearer ${auth.token}`,
  };
}

export async function getMe(): Promise<MeResponse> {
  const res = await fetch(`${BASE}/api/v1/me`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error("获取当前用户失败");
  return res.json();
}

export interface AccountTenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  roles: UserRole[];
  current: boolean;
}

async function authJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export async function updateAccountProfile(name: string, avatarUrl?: string): Promise<MeResponse> {
  return authJson("/api/account/profile", {
    method: "PATCH",
    body: JSON.stringify({ name, avatar_url: avatarUrl || null }),
  });
}

export async function listAccountTenants(): Promise<AccountTenant[]> {
  const data = await authJson<{ items: Tenant[]; active_tenant_id: string | null }>(
    "/api/v1/auth/tenants"
  );
  return data.items.map((tenant) => ({
    ...tenant, roles: tenant.roles ?? [], current: tenant.id === data.active_tenant_id,
  }));
}

export async function switchAccountTenant(tenantId: string): Promise<LoginResponse> {
  const data = await authJson<LoginResponse>("/api/v1/auth/switch-tenant", {
    method: "POST",
    body: JSON.stringify({ tenant_id: tenantId }),
  });
  storeLoginResponse(data);
  localStorage.setItem(TENANT_SWITCH_STORAGE_KEY, `${tenantId}:${Date.now()}`);
  const basePath = window.location.pathname.startsWith("/documind") ? "/documind" : "";
  window.location.replace(`${basePath}${AUTHENTICATED_HOME_PATH}`);
  return data;
}

function storeLoginResponse(data: LoginResponse) {
  setStoredAuth({
    token: data.access_token,
    userId: data.user.id,
    tenantId: data.tenant?.id ?? null,
    loginId: data.user.login_id,
    email: data.user.email,
    scope: data.scope,
    roles: data.roles,
  });
}

export async function getTenantLoginContext(tenantSlug: string): Promise<TenantLoginContext> {
  const slug = tenantSlug.trim();
  const response = await fetch(
    `${BASE}/api/v1/auth/tenant-context?tenant=${encodeURIComponent(slug)}`,
    { headers: { Accept: "application/json" } }
  );
  if (!response.ok) {
    throw new Error(response.status === 404 ? "企业登录入口不存在或暂不可用" : "暂时无法识别企业登录入口");
  }
  return response.json() as Promise<TenantLoginContext>;
}

export async function loginWithPassword(
  username: string,
  password: string
): Promise<LoginResponse> {
  return authenticate("/api/v1/auth/login", { username, password });
}

export async function register(
  username: string,
  password: string
): Promise<LoginResponse> {
  return authenticate("/api/v1/auth/register", { username, password });
}

async function authenticate(path: string, body: Record<string, string>): Promise<LoginResponse> {
  const data = await authJson<LoginResponse>(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  storeLoginResponse(data);
  return data;
}

export async function createTenant(name: string): Promise<LoginResponse> {
  const data = await authJson<LoginResponse>("/api/v1/tenants", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ name }),
  });
  storeLoginResponse(data);
  localStorage.setItem(TENANT_SWITCH_STORAGE_KEY, `${data.tenant?.id ?? "created"}:${Date.now()}`);
  const basePath = window.location.pathname.startsWith("/documind") ? "/documind" : "";
  window.location.replace(`${basePath}${AUTHENTICATED_HOME_PATH}`);
  return data;
}

export interface InvitationValidation {
  valid: true;
  tenant: { name: string };
  kind: "targeted" | "bootstrap_owner";
  invitee_hint: string | null;
  roles: string[];
  expires_at: string;
}

export async function validateInvitation(token: string): Promise<InvitationValidation> {
  const response = await fetch(`${BASE}/api/v1/invitations/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message || "邀请链接无效或已过期");
  }
  const data = await response.json() as InvitationValidation | { valid: false; code: string };
  if (!data.valid) throw new Error("邀请链接无效或已过期");
  return data;
}

export async function acceptInvitation(token: string): Promise<LoginResponse> {
  const data = await authJson<LoginResponse>("/api/v1/invitations/accept", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  storeLoginResponse(data);
  return data;
}

export async function logoutRequest() {
  try {
    await fetch(`${BASE}/api/v1/auth/logout`, {
      method: "POST",
      headers: getAuthHeaders(),
    });
  } catch {
    // Local logout should still succeed if the network request fails.
  } finally {
    clearStoredAuth();
  }
}

export function logout() {
  clearStoredAuth();
  window.location.href = "/login";
}

export function isSuperAdminRole(roles: UserRole[] | string[]): boolean {
  return roles.includes("super_admin");
}

export function isTenantAdminRole(roles: UserRole[] | string[]): boolean {
  return roles.some((role) =>
    [
      "enterprise_admin",
      "team_admin",
      "data_admin",
      "tenant_owner",
      "tenant_admin",
    ].includes(role)
  );
}

export function canAccessAdmin(roles: UserRole[] | string[]): boolean {
  return !isSuperAdminRole(roles) && isTenantAdminRole(roles);
}
