"use client";

import { useEffect, useMemo, useState } from "react";
import { Database } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { Topbar } from "@/components/ui/topbar";
import { listSystemVectorIndexes, type SystemVectorIndex } from "@/lib/api";

export function SystemVectorIndexes() {
  const [indexes, setIndexes] = useState<SystemVectorIndex[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    listSystemVectorIndexes()
      .then(setIndexes)
      .catch((error) => {
        console.error(error);
        setIndexes([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return indexes;
    return indexes.filter((idx) =>
      [idx.name, idx.alias, idx.tenant, idx.kb_name, idx.embedding_model, idx.index_version]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [indexes, query]);

  return (
    <>
      <Topbar title="向量索引" />
      <div className="dm-admin-content">
        <div style={{ alignItems: "center", display: "flex", gap: 12, marginBottom: 16 }}>
          <SearchInput
            placeholder="搜索索引、知识库或模型..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>共 {filtered.length} 个索引</span>
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
          {loading ? <div className="dm-empty-state">加载向量索引中...</div> : null}
          {!loading && filtered.map((idx) => (
            <div className="dm-vector-index-row" key={idx.id}>
              <div className="dm-user-cell">
                <span className="dm-avatar">
                  <Database size={14} />
                </span>
                <span>
                  <strong>{idx.name}</strong>
                  <small>{idx.kb_name} · {idx.embedding_model}</small>
                </span>
              </div>
              <span>{idx.tenant}</span>
              <span>{idx.dimension || "-"}</span>
              <span>{idx.documents.toLocaleString()}</span>
              <span>{idx.embedded_chunks.toLocaleString()} / {idx.chunks.toLocaleString()}</span>
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
              <span>{idx.lastIndexed ? new Date(idx.lastIndexed).toLocaleString() : "尚未索引"}</span>
            </div>
          ))}
          {!loading && filtered.length === 0 ? <div className="dm-empty-state">暂无向量索引数据</div> : null}
        </Panel>
      </div>
    </>
  );
}
