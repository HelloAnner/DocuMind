"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/providers/auth-provider";
import { defaultRouteForRole } from "@/lib/auth";

export default function HomePage() {
  const router = useRouter();
  const { me, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (me) {
      router.replace(defaultRouteForRole(me.roles[0]));
    } else {
      router.replace("/login");
    }
  }, [me, loading, router]);

  return (
    <main style={{ height: "100vh", display: "grid", placeItems: "center", color: "var(--text-muted)" }}>
      <span>正在打开 DocuMind 登录页…</span>
    </main>
  );
}
