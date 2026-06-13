"use client";

import Link from "next/link";
import { Download, FileText, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";
import { Topbar } from "@/components/ui/topbar";

const recentDocuments = [
  { name: "2025年度销售策略.pptx", meta: "2.4 MB · 47 切片 · 2025-06-10", status: "已完成" as const },
  { name: "Q3 采购合同模板.docx", meta: "856 KB · 12 切片 · 2025-06-09", status: "已完成" as const },
  { name: "员工报销政策 2025.pdf", meta: "1.2 MB · 28 切片 · 2025-06-08", status: "已完成" as const },
  { name: "产品安全规范 v2.1.pptx", meta: "3.1 MB · 待解析 · 2025-06-08", status: "解析中" as const },
];

const healthItems = [
  { label: "Elasticsearch", value: "正常", width: "80%", tone: "success" as const },
  { label: "向量索引", value: "正常", width: "92%", tone: "success" as const },
  { label: "LLM Provider", value: "正常", width: "88%", tone: "success" as const },
  { label: "Embedding Worker", value: "队列 3", width: "34%", tone: "danger" as const },
];

const topQuestions = [
  { question: "Q3 销售目标是多少？", count: 42 },
  { question: "采购合同违约条款", count: 38 },
  { question: "员工报销需要哪些材料？", count: 31 },
  { question: "产品安全规范要求", count: 27 },
];

export function AdminOverview() {
  return (
    <>
      <Topbar title="概览">
        <Button variant="secondary" icon={<Download size={14} />}>导出报表</Button>
        <Link href="/admin/documents">
          <Button icon={<Upload size={14} />}>上传文档</Button>
        </Link>
      </Topbar>

      <div className="dm-admin-content">
        <div className="dm-stat-row">
          <StatCard label="总文档数" value="128" hint="+12 本月" />
          <StatCard label="总切片数" value="4,832" hint="+312 本周" />
          <StatCard label="问答总量" value="1,245" hint="+89 今日" />
          <StatCard label="检索命中率" value="92.4%" hint="↑ 1.2%" />
        </div>

        <div className="dm-overview-grid">
          <Panel title="Recent Documents" action={<Link href="/admin/documents">查看全部 →</Link>}>
            {recentDocuments.map((doc) => {
              const tone = doc.status === "已完成" ? "success" : "warning";
              return (
                <div className="dm-recent-doc-row" key={doc.name}>
                  <span className="dm-recent-doc-name">
                    <FileText size={18} />
                    <span>
                      <strong>{doc.name}</strong>
                      <small>{doc.meta}</small>
                    </span>
                  </span>
                  <Badge tone={tone}>{doc.status}</Badge>
                </div>
              );
            })}
          </Panel>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Panel title="System Health">
              {healthItems.map((item) => (
                <div className="dm-health-row" key={item.label}>
                  <div>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                  <div className="dm-bar">
                    <span className={item.tone} style={{ width: item.width }} />
                  </div>
                </div>
              ))}
            </Panel>

            <Panel title="Top Questions">
              {topQuestions.map((item) => (
                <div
                  className="dm-document-row"
                  key={item.question}
                  style={{ gridTemplateColumns: "1fr auto", cursor: "default" }}
                >
                  <span style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 500 }}>
                    {item.question}
                  </span>
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{item.count} 次</span>
                </div>
              ))}
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}
