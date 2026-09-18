"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Database, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { StatCard } from "@/components/ui/stat-card";
import { Topbar } from "@/components/ui/topbar";
import {
  listSystemVectorIndexes,
  type SystemVectorSnapshot,
} from "@/lib/api";

const statusLabel = {
  healthy: "健康",
  building: "构建中",
  degraded: "需处理",
};

export function SystemVectorIndexes() {
  const [snapshot, setSnapshot] = useState<SystemVectorSnapshot>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setSnapshot(await listSystemVectorIndexes());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "向量索引对账失败");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(console.error);
  }, [refresh]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return snapshot?.indexes ?? [];
    return (snapshot?.indexes ?? []).filter((index) =>
      [index.alias, index.physical_index, index.tenant, index.kb_name, index.embedding_model]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [snapshot, query]);

  return (
    <>
      <Topbar title="向量索引">
        <Button
          disabled={refreshing}
          icon={<RefreshCw size={14} />}
          onClick={() => refresh().catch(console.error)}
          variant="secondary"
        >
          {refreshing ? "对账中" : "重新对账"}
        </Button>
      </Topbar>
      <div className="dm-admin-content dm-ops-page">
        <div className="dm-stat-row">
          <StatCard
            label="PostgreSQL 应有切片"
            value={snapshot ? snapshot.summary.expected_chunks.toLocaleString() : "-"}
            hint="当前文档版本"
          />
          <StatCard
            label="Elasticsearch 实有切片"
            value={snapshot ? snapshot.summary.actual_chunks.toLocaleString() : "-"}
            hint={snapshot?.summary.physical_index ?? "正在读取活动索引"}
          />
          <StatCard
            label="缺失或陈旧"
            value={snapshot ? snapshot.summary.missing_or_stale_chunks.toLocaleString() : "-"}
            hint={snapshot?.summary.consistent ? "两端一致" : "需要修复"}
          />
        </div>
        {error ? <div className="dm-error-banner" role="alert">{error}</div> : null}

        <div className="dm-ops-toolbar">
          <SearchInput
            placeholder="搜索租户、知识库、索引或模型..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {snapshot ? (
            <div className="dm-vector-source">
              <Badge tone={snapshot.summary.consistent ? "success" : "danger"}>
                {snapshot.summary.consistent ? "实时对账一致" : "实时对账异常"}
              </Badge>
              <span>{snapshot.summary.index_alias}</span>
              <time dateTime={snapshot.checked_at}>{new Date(snapshot.checked_at).toLocaleString()}</time>
            </div>
          ) : null}
        </div>

        <Panel
          className="dm-ops-panel"
          title={`知识库索引 · ${filtered.length}`}
          action={<span>数据来自 PostgreSQL 与 Elasticsearch 实时对账</span>}
        >
          {!snapshot && !error ? <div className="dm-empty-state">正在读取并核对向量索引...</div> : null}
          {snapshot && filtered.length === 0 ? (
            <div className="dm-ops-empty">
              <span><Database size={20} /></span>
              <strong>没有向量索引</strong>
              <p>{query ? "没有符合搜索条件的知识库索引。" : "数据库中尚无知识库索引数据。"}</p>
            </div>
          ) : null}
          {filtered.length > 0 ? (
            <>
              <div className="dm-table-head dm-vector-live-row">
                <span>知识库</span>
                <span>模型 / 维度</span>
                <span>文档</span>
                <span>向量切片</span>
                <span>异常</span>
                <span>状态</span>
                <span>最近索引</span>
              </div>
              {filtered.map((index) => (
                <div className="dm-vector-live-row" key={index.id}>
                  <div className="dm-user-cell">
                    <span className="dm-avatar"><Database size={14} /></span>
                    <span><strong>{index.kb_name}</strong><small>{index.tenant}</small></span>
                  </div>
                  <span>{index.embedding_model}<small>{index.dimension} 维</small></span>
                  <span>{index.documents.toLocaleString()}<small>{index.building_documents} 构建中</small></span>
                  <span>{index.embedded_chunks.toLocaleString()} / {index.chunks.toLocaleString()}</span>
                  <span>{(index.degraded_documents + index.failed_embeddings).toLocaleString()}</span>
                  <Badge tone={index.status === "healthy" ? "success" : index.status === "building" ? "warning" : "danger"}>
                    {statusLabel[index.status]}
                  </Badge>
                  <span>{index.last_indexed_at ? new Date(index.last_indexed_at).toLocaleString() : "尚未索引"}</span>
                </div>
              ))}
            </>
          ) : null}
        </Panel>
      </div>
    </>
  );
}
