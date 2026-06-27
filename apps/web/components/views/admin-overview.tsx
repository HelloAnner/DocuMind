"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FileText, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson } from "@/lib/api";

interface AdminOverviewData {
  doc_count: number;
  indexed_doc_count: number;
  chunk_count: number;
  active_users: number;
  failed_docs: number;
  running_jobs: number;
  knowledge_bases: Array<{
    name: string;
    doc_count: number;
    chunk_count: number;
    status: string;
  }>;
  alerts: Array<{ message: string; action?: string }>;
}

export function AdminOverview() {
  const [data, setData] = useState<AdminOverviewData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchJson<AdminOverviewData>("/api/admin/overview")
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "概览加载失败"));
  }, []);

  return (
    <>
      <Topbar title="概览">
        <Link href="/admin/documents">
          <Button icon={<Upload size={14} />}>上传文档</Button>
        </Link>
      </Topbar>

      <div className="dm-admin-content">
        <div className="dm-stat-row">
          <StatCard label="总文档数" value={String(data?.doc_count ?? "-")} hint={`${data?.indexed_doc_count ?? 0} 已索引`} />
          <StatCard label="总切片数" value={(data?.chunk_count ?? 0).toLocaleString()} hint="当前租户" />
          <StatCard label="活跃成员" value={String(data?.active_users ?? "-")} hint="已启用" />
          <StatCard label="运行任务" value={String(data?.running_jobs ?? "-")} hint={`${data?.failed_docs ?? 0} 失败文档`} />
        </div>
        {error ? <div className="dm-error-banner">{error}</div> : null}

        <div className="dm-overview-grid">
          <Panel title="知识库状态" action={<Link href="/admin/knowledge">查看全部 →</Link>}>
            {(data?.knowledge_bases ?? []).map((kb) => {
              const tone = kb.status === "active" ? "success" : "warning";
              return (
                <div className="dm-recent-doc-row" key={kb.name}>
                  <span className="dm-recent-doc-name">
                    <FileText size={18} />
                    <span>
                      <strong>{kb.name}</strong>
                      <small>{kb.doc_count.toLocaleString()} 文档 · {kb.chunk_count.toLocaleString()} 切片</small>
                    </span>
                  </span>
                  <Badge tone={tone}>{kb.status}</Badge>
                </div>
              );
            })}
            {data && data.knowledge_bases.length === 0 ? <div className="dm-empty-state">暂无知识库</div> : null}
          </Panel>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Panel title="System Health">
              {[
                { label: "索引完成", value: `${data?.indexed_doc_count ?? 0}/${data?.doc_count ?? 0}` },
                { label: "运行任务", value: String(data?.running_jobs ?? 0) },
                { label: "失败文档", value: String(data?.failed_docs ?? 0) },
              ].map((item) => (
                <div className="dm-health-row" key={item.label}>
                  <div><span>{item.label}</span><strong>{item.value}</strong></div>
                </div>
              ))}
            </Panel>

            <Panel title="待关注">
              {(data?.alerts ?? []).map((item) => (
                <div className="dm-document-row" key={item.message} style={{ gridTemplateColumns: "1fr", cursor: "default" }}>
                  <span style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 500 }}>{item.message}</span>
                </div>
              ))}
              {data && data.alerts.length === 0 ? <div className="dm-empty-state">暂无告警</div> : null}
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}
