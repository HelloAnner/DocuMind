"use client";

import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { Segmented } from "@/components/ui/segmented";
import { Topbar } from "@/components/ui/topbar";

const filters = [
  { value: "today", label: "今天" },
  { value: "week", label: "近7天" },
  { value: "month", label: "近30天" },
  { value: "all", label: "全部" },
] as const;

const logs = [
  { question: "Q3 华东区的销售目标是多少？", kb: "产品文档库", user: "张三", score: "0.92", feedback: "up", time: "10:32" },
  { question: "采购合同中的违约责任怎么定义？", kb: "销售资料库", user: "李四", score: "0.88", feedback: "up", time: "10:15" },
  { question: "员工报销需要哪些材料？", kb: "人力资源库", user: "王五", score: "0.76", feedback: "down", time: "09:48" },
  { question: "产品安全规范的最新要求是什么？", kb: "研发规范库", user: "赵六", score: "0.95", feedback: "up", time: "09:20" },
  { question: "市场活动预算审批流程", kb: "产品文档库", user: "张三", score: "0.64", feedback: "none", time: "昨天" },
];

export function AdminLogs() {
  const [filter, setFilter] = useState<typeof filters[number]["value"]>("today");

  const scoreTone = (score: string) => {
    const n = parseFloat(score);
    if (n >= 0.9) return "success";
    if (n >= 0.8) return "info";
    if (n >= 0.7) return "warning";
    return "danger";
  };

  const feedbackIcon = (feedback: string) => {
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

        <Panel title="Q&A Logs" action={<span>共 124 条记录</span>}>
          <div className="dm-table-head dm-log-row">
            <span>问题</span>
            <span>知识库</span>
            <span>用户</span>
            <span>置信度</span>
            <span>反馈</span>
            <span>时间</span>
          </div>
          {logs.map((log) => (
            <div className="dm-log-row" key={log.question}>
              <span>{log.question}</span>
              <span>{log.kb}</span>
              <span>{log.user}</span>
              <span>
                <Badge tone={scoreTone(log.score)}>{log.score}</Badge>
              </span>
              <span>{feedbackIcon(log.feedback)}</span>
              <span>{log.time}</span>
            </div>
          ))}
        </Panel>
      </div>
    </>
  );
}
