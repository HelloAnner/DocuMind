"use client";

import { BarChart3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";
import { Topbar } from "@/components/ui/topbar";

export function SystemOverview() {
  return (
    <>
      <Topbar title="系统总览" />
      <div className="dm-admin-content">
        <div className="dm-stat-row">
          <StatCard label="租户数" value="18" hint="+2 本月" />
          <StatCard label="检索次数（24h）" value="1.2M" hint="↑ 8%" />
          <StatCard label="生成成功率" value="99.3%" hint="稳定" />
          <StatCard label="P95 检索" value="42ms" hint="↓ 3ms" />
        </div>

        <div className="dm-overview-grid" style={{ marginTop: 24 }}>
          <Panel title="模型服务">
            {[
              { name: "chat-default", model: "qwen-plus", status: "healthy", throughput: "18 req/min" },
              { name: "embedding-default", model: "bge-large-zh", status: "healthy", throughput: "240 chunks/min" },
              { name: "reranker-default", model: "bge-reranker", status: "degraded", throughput: "p95 890ms" },
            ].map((m) => (
              <div className="dm-system-row" key={m.name}>
                <div>
                  <strong>{m.name}</strong>
                  <small>{m.model}</small>
                </div>
                <Badge tone={m.status === "healthy" ? "success" : "warning"}>{m.status}</Badge>
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{m.throughput}</span>
              </div>
            ))}
          </Panel>

          <Panel title="待关注">
            {[
              { message: "tenant:acme 向量化队列积压 2,341 个 chunk", action: "查看任务" },
              { message: "tenant:beta 本月存储配额使用 86%", action: "调整配额" },
              { message: "3 次 LLM provider fallback", action: "查看日志" },
            ].map((a) => (
              <div className="dm-system-row" key={a.message}>
                <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>{a.message}</span>
                <button className="dm-button ghost" style={{ height: 28, padding: "0 10px", fontSize: 12 }}>
                  {a.action}
                </button>
              </div>
            ))}
          </Panel>
        </div>
      </div>
    </>
  );
}
