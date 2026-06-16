"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function TenantIndexPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/tenant/knowledge");
  }, [router]);

  return (
    <main style={{ height: "100vh", display: "grid", placeItems: "center", color: "var(--text-muted)" }}>
      <span>正在进入租户后台…</span>
    </main>
  );
}
