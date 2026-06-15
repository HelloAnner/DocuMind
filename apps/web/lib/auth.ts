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
}

export interface MeResponse {
  user: User;
  tenant: Tenant;
  roles: UserRole[];
  permissions: string[];
  allowed_kb_ids: string[];
}

export interface LoginResponse extends MeResponse {
  access_token: string;
  token_type: "bearer";
}

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";
const AUTH_KEY = "documind-auth";

export interface StoredAuth {
  token: string;
  userId: string;
  tenantId: string;
  email: string;
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

export async function loginWithPassword(username: string, password: string): Promise<MeResponse> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error("用户名或密码错误");
  const data: LoginResponse = await res.json();
  setStoredAuth({
    token: data.access_token,
    userId: data.user.id,
    tenantId: data.tenant.id,
    email: data.user.email,
    roles: data.roles,
  });
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

export function defaultRouteForRole(role: UserRole): string {
  switch (role) {
    case "super_admin":
      return "/system";
    case "enterprise_admin":
    case "team_admin":
    case "data_admin":
    case "tenant_owner":
    case "tenant_admin":
      return "/admin";
    case "viewer":
      return "/knowledge";
    case "user":
    case "analyst":
    case "end_user":
    default:
      return "/chat";
  }
}
