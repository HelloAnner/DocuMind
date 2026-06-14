export type UserRole = "super_admin" | "tenant_owner" | "tenant_admin" | "end_user" | "viewer";

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

export interface DevLoginResponse {
  user_id: string;
  tenant_id: string;
  email: string;
  role: UserRole;
  token: string;
  headers: {
    "x-user-id": string;
    "x-tenant-id": string;
    "x-role": string;
  };
}

const AUTH_KEY = "documind-auth";

export interface StoredAuth {
  userId: string;
  tenantId: string;
  email: string;
  role: UserRole;
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
  if (!auth) return {};
  return {
    "x-user-id": auth.userId,
    "x-tenant-id": auth.tenantId,
    "x-role": auth.role,
  };
}

export async function getMe(): Promise<MeResponse> {
  const res = await fetch("/api/me", { headers: getAuthHeaders() });
  if (!res.ok) throw new Error("获取当前用户失败");
  return res.json();
}

export async function devLogin(email: string, role: UserRole): Promise<MeResponse> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) throw new Error("登录失败");
  const data: DevLoginResponse = await res.json();
  setStoredAuth({
    userId: data.user_id,
    tenantId: data.tenant_id,
    email: data.email,
    role: data.role,
  });
  return getMe();
}

export function logout() {
  clearStoredAuth();
  window.location.href = "/login";
}

export function defaultRouteForRole(role: UserRole): string {
  switch (role) {
    case "super_admin":
      return "/system";
    case "tenant_owner":
    case "tenant_admin":
      return "/admin";
    case "end_user":
      return "/chat";
    case "viewer":
      return "/knowledge";
    default:
      return "/chat";
  }
}
