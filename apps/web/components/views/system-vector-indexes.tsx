"use client";

import { Database } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { Topbar } from "@/components/ui/topbar";

interface VectorIndex {
  id: string;
  name: string;
  tenant: string;
  dimension: number;
  documents: number;
  chunks: number;
  status: "healthy" | "building" | "degraded";
  lastIndexed: string;
}

const mockIndexes: VectorIndex[] = [
  {
    id: "1",
    name: "idx_kb_01",
    tenant: "acme",
    dimension: 1024,
    documents: 3201,
    chunks: 48291,
    status: "healthy",
    lastIndexed: "2 小时前",
  },
  {
    id: "2",
    name: "idx_kb_02",
    tenant: "beta",
    dimension: 1024,
    documents: 1044,
    chunks: 15302,
    status: "healthy",
    lastIndexed: "昨天",
  },
  {
    id: "3",
    name: "idx_kb_03",
    tenant: "acme",
    dimension: 768,
    documents: 328,
    chunks: 5120,
    status: "building",
    lastIndexed: "索引中",
  },
];

export function SystemVectorIndexes() {
  return (
    <>
      <Topbar title="向量索引" />
      <div className="dm-admin-content">
        <div style={{ alignItems: "center", display: "flex", gap: 12, marginBottom: 16 }}>
          <SearchInput placeholder="搜索索引..." />
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>共 {mockIndexes.length} 个索引</span>
        </div>

        <Panel title="Indexes">
          <div className="dm-table-head dm-vector-index-row">
            <span>名称</span>
            <span>租户</span>
            <span>维度</span>
            <span>文档数</span>
            <span>切片数</span>
            <span>状态</span>
            <span>最近索引</span>
          </div>
          {mockIndexes.map((idx) => (
            <div className="dm-vector-index-row" key={idx.id}>
              <div className="dm-user-cell">
                <span className="dm-avatar">
                  <Database size={14} />
                </span>
                <span>
                  <strong>{idx.name}</strong>
                </span>
              </div>
              <span>{idx.tenant}</span>
              <span>{idx.dimension}</span>
              <span>{idx.documents.toLocaleString()}</span>
              <span>{idx.chunks.toLocaleString()}</span>
              <span>
                <Badge
                  tone={
                    idx.status === "healthy"
                      ? "success"
                      : idx.status === "building"
                      ? "warning"
                      : "danger"
                  }
                >
                  {idx.status}
                </Badge>
              </span>
              <span>{idx.lastIndexed}</span>
            </div>
          ))}
        </Panel>
      </div>
    </>
  );
}
