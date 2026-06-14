"use client";

import { Topbar } from "@/components/ui/topbar";

export default function SystemSettingsPage() {
  return (
    <>
      <Topbar title="系统设置" />
      <div className="dm-admin-content">
        <p style={{ color: "var(--text-muted)" }}>全局系统设置将在后续版本提供。</p>
      </div>
    </>
  );
}
