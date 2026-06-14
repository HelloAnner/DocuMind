"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { SystemSidebar } from "@/components/ui/system-sidebar";
import { useAuth } from "@/components/providers/auth-provider";

export default function SystemLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { me, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!me || !me.roles.includes("super_admin")) {
      router.replace("/");
    }
  }, [me, loading, router]);

  if (loading || !me) {
    return (
      <main className="dm-shell">
        <SystemSidebar />
        <section className="dm-workspace" style={{ display: "grid", placeItems: "center", color: "var(--text-muted)" }}>
          <span>加载中…</span>
        </section>
      </main>
    );
  }

  return (
    <main className="dm-shell">
      <SystemSidebar />
      <section className="dm-workspace">{children}</section>
    </main>
  );
}
