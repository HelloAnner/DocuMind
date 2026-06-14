"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { clearStoredAuth, defaultRouteForRole, devLogin, getMe, getStoredAuth, type MeResponse, type StoredAuth, type UserRole } from "@/lib/auth";

interface AuthContextValue {
  me: MeResponse | null;
  loading: boolean;
  login: (email: string, role: UserRole) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await getMe();
      setMe(data);
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      await refresh();
      if (mounted) setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [refresh]);

  const login = useCallback(
    async (email: string, role: UserRole) => {
      const data = await devLogin(email, role);
      setMe(data);
      router.replace(defaultRouteForRole(data.roles[0] ?? role));
    },
    [router]
  );

  const logout = useCallback(() => {
    clearStoredAuth();
    setMe(null);
    router.replace("/login");
  }, [router]);

  return (
    <AuthContext.Provider value={{ me, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export { getStoredAuth };
