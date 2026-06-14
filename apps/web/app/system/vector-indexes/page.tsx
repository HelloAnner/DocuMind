"use client";

import { Topbar } from "@/components/ui/topbar";

export default function VectorIndexesPage() {
  return (
    <>
      <Topbar title="向量索引" />
      <div className="dm-admin-content">
        <p style={{ color: "var(--text-muted)" }}>向量索引列表将在后续版本提供。</p>
      </div>
    </>
  );
}
