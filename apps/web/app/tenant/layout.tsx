"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { TenantSidebar } from "@/components/ui/tenant-sidebar";
import { useAuth } from "@/components/providers/auth-provider";

export default function TenantLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { me, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    const canAccess = me && (
      me.roles.includes("tenant_admin") ||
      me.roles.includes("tenant_owner")
    );
    if (!canAccess) {
      router.replace("/");
    }
  }, [me, loading, router]);

  if (loading || !me) {
    return (
      <main className="dm-shell">
        <TenantSidebar />
        <section className="dm-workspace" style={{ display: "grid", placeItems: "center", color: "var(--text-muted)" }}>
          <span>加载中…</span>
        </section>
      </main>
    );
  }

  return (
    <main className="dm-shell">
      <TenantSidebar />
      <section className="dm-workspace">{children}</section>
    </main>
  );
}
