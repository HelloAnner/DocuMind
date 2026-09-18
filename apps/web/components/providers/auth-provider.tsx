"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  authenticatedHomePath,
  getMe,
  getStoredAuth,
  loginWithPassword,
  logoutRequest,
  register as registerAccount,
  type MeResponse,
} from "@/lib/auth";

interface AuthContextValue {
  me: MeResponse | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
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

  const finishAuthentication = useCallback((data: MeResponse) => {
    setMe(data);
    router.replace(
      data.tenant ? authenticatedHomePath(data.scope, data.roles) : "/onboarding/tenant"
    );
  }, [router]);

  const login = useCallback(
    async (username: string, password: string) => {
      finishAuthentication(await loginWithPassword(username, password));
    },
    [finishAuthentication]
  );

  const register = useCallback(
    async (username: string, password: string) => {
      finishAuthentication(await registerAccount(username, password));
    },
    [finishAuthentication]
  );

  const logout = useCallback(() => {
    logoutRequest().finally(() => {
      setMe(null);
      router.replace("/login");
    });
  }, [router]);

  return (
    <AuthContext.Provider value={{ me, loading, login, register, logout, refresh }}>
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
