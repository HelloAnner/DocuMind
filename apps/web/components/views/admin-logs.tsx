"use client";

import { useEffect, useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { Segmented } from "@/components/ui/segmented";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson } from "@/lib/api";

interface QaLog {
  id: string;
  question: string;
  kb_name: string;
  user_name: string;
  score: number;
  feedback?: string;
  created_at: string;
}

const filters = [
  { value: "today", label: "今天" },
  { value: "week", label: "近7天" },
  { value: "month", label: "近30天" },
  { value: "all", label: "全部" },
] as const;

export function AdminLogs() {
  const [logs, setLogs] = useState<QaLog[]>([]);
  const [filter, setFilter] = useState<typeof filters[number]["value"]>("today");

  useEffect(() => {
    fetchJson<QaLog[]>("/api/admin/logs").then(setLogs).catch(console.error);
  }, []);

  const scoreTone = (score: number) => {
    if (score >= 0.9) return "success";
    if (score >= 0.8) return "info";
    if (score >= 0.7) return "warning";
    return "danger";
  };

  const feedbackIcon = (feedback?: string) => {
    if (feedback === "up") return <ThumbsUp size={12} />;
    if (feedback === "down") return <ThumbsDown size={12} />;
    return <span>—</span>;
  };

  return (
    <>
      <Topbar title="问答日志" />

      <div className="dm-admin-content">
        <div className="dm-log-toolbar">
          <Segmented options={filters} value={filter} onChange={setFilter} />
          <SearchInput placeholder="搜索问题或用户..." />
        </div>

        <Panel title="Q&A Logs" action={<span>共 {logs.length} 条记录</span>}>
          <div className="dm-table-head dm-log-row">
            <span>问题</span>
            <span>知识库</span>
            <span>用户</span>
            <span>置信度</span>
            <span>反馈</span>
            <span>时间</span>
          </div>
          {logs.map((log) => (
            <div className="dm-log-row" key={log.id}>
              <span>{log.question}</span>
              <span>{log.kb_name}</span>
              <span>{log.user_name}</span>
              <span>
                <Badge tone={scoreTone(log.score)}>{log.score.toFixed(2)}</Badge>
              </span>
              <span>{feedbackIcon(log.feedback)}</span>
              <span>{new Date(log.created_at).toLocaleString()}</span>
            </div>
          ))}
        </Panel>
      </div>
    </>
  );
}
