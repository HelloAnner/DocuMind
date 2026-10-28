"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AUTHENTICATED_HOME_PATH,
  getMe,
  getStoredAuth,
  loginWithPassword,
  INVITATION_STORAGE_KEY,
  logoutRequest,
  TENANT_SWITCH_STORAGE_KEY,
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
  useEffect(() => {
    const reloadForTenantSwitch = (event: StorageEvent) => {
      if (event.key === TENANT_SWITCH_STORAGE_KEY) window.location.reload();
    };
    window.addEventListener("storage", reloadForTenantSwitch);
    return () => window.removeEventListener("storage", reloadForTenantSwitch);
  }, []);


  const finishAuthentication = useCallback((data: MeResponse) => {
    setMe(data);
    router.replace(sessionStorage.getItem(INVITATION_STORAGE_KEY)
      ? "/invite"
      : data.tenant ? AUTHENTICATED_HOME_PATH : "/onboarding/tenant");
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
