"use client";

import { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson } from "@/lib/api";

interface SystemOverviewData {
  tenant_count: number;
  user_count: number;
  kb_count: number;
  doc_count: number;
  indexed_doc_count: number;
  chunk_count: number;
  running_jobs: number;
  failed_docs: number;
  models: Array<{ name: string; model: string; status: string }>;
  alerts: Array<{ message: string; action?: string }>;
}

export function SystemOverview() {
  const [data, setData] = useState<SystemOverviewData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchJson<SystemOverviewData>("/api/system/overview")
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "系统总览加载失败"));
  }, []);

  return (
    <>
      <Topbar title="系统总览" />
      <div className="dm-admin-content">
        <div className="dm-stat-row">
          <StatCard label="租户数" value={String(data?.tenant_count ?? "-")} hint="当前实例" />
          <StatCard label="文档数" value={String(data?.doc_count ?? "-")} hint={`${data?.indexed_doc_count ?? 0} 已索引`} />
          <StatCard label="切片数" value={(data?.chunk_count ?? 0).toLocaleString()} hint="PostgreSQL" />
          <StatCard label="运行任务" value={String(data?.running_jobs ?? "-")} hint={`${data?.failed_docs ?? 0} 失败文档`} />
        </div>
        {error ? <div className="dm-error-banner">{error}</div> : null}

        <div className="dm-overview-grid" style={{ marginTop: 24 }}>
          <Panel title="模型服务">
            {(data?.models ?? []).map((m) => (
              <div className="dm-system-row" key={m.name}>
                <div>
                  <strong>{m.name}</strong>
                  <small>{m.model}</small>
                </div>
                <Badge tone={m.status === "configured" ? "success" : "warning"}>{m.status}</Badge>
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>runtime config</span>
              </div>
            ))}
            {data && data.models.length === 0 ? <div className="dm-empty-state">暂无模型配置</div> : null}
          </Panel>

          <Panel title="待关注">
            {(data?.alerts ?? []).map((a) => (
              <div className="dm-system-row" key={a.message} style={{ gridTemplateColumns: "1fr" }}>
                <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>{a.message}</span>
              </div>
            ))}
            {data && data.alerts.length === 0 ? <div className="dm-empty-state">暂无告警</div> : null}
          </Panel>
        </div>
      </div>
    </>
  );
}
