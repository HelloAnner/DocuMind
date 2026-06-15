"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AdminSidebar } from "@/components/ui/admin-sidebar";
import { useAuth } from "@/components/providers/auth-provider";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { me, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    const canAccess = me && (
      me.roles.includes("enterprise_admin") ||
      me.roles.includes("team_admin") ||
      me.roles.includes("data_admin") ||
      me.roles.includes("tenant_admin") ||
      me.roles.includes("tenant_owner") ||
      me.roles.includes("super_admin")
    );
    if (!canAccess) {
      router.replace("/");
    }
  }, [me, loading, router]);

  if (loading || !me) {
    return (
      <main className="dm-shell">
        <AdminSidebar />
        <section className="dm-workspace" style={{ display: "grid", placeItems: "center", color: "var(--text-muted)" }}>
          <span>加载中…</span>
        </section>
      </main>
    );
  }

  return (
    <main className="dm-shell">
      <AdminSidebar />
      <section className="dm-workspace">{children}</section>
    </main>
  );
}
