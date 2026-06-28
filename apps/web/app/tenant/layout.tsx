"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AdminShellSidebar } from "@/components/ui/admin-shell-sidebar";
import { useAuth } from "@/components/providers/auth-provider";
import { isTenantAdminRole } from "@/lib/auth";

export default function TenantLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { me, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    const canAccess = me && isTenantAdminRole(me.roles);
    if (!canAccess) {
      router.replace("/");
    }
  }, [me, loading, router]);

  if (loading || !me) {
    return (
      <main className="dm-shell">
        <AdminShellSidebar />
        <section className="dm-workspace" style={{ display: "grid", placeItems: "center", color: "var(--text-muted)" }}>
          <span>加载中…</span>
        </section>
      </main>
    );
  }

  return (
    <main className="dm-shell">
      <AdminShellSidebar />
      <section className="dm-workspace">{children}</section>
    </main>
  );
}
