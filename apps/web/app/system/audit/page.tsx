"use client";

import { Topbar } from "@/components/ui/topbar";

export default function AuditPage() {
  return (
    <>
      <Topbar title="审计日志" />
      <div className="dm-admin-content">
        <p style={{ color: "var(--text-muted)" }}>全量审计日志将在后续版本提供。</p>
      </div>
    </>
  );
}
