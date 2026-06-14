"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson } from "@/lib/api";

interface Job {
  id: string;
  tenant_name: string;
  kind: string;
  status: string;
  progress: number;
  created_at: string;
}

export function SystemJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    fetchJson<Job[]>("/api/system/jobs").then(setJobs).catch(console.error);
  }, []);

  return (
    <>
      <Topbar title="任务队列" />
      <div className="dm-admin-content">
        <Panel title="Jobs">
          <div className="dm-table-head dm-job-row">
            <span>租户</span>
            <span>类型</span>
            <span>状态</span>
            <span>进度</span>
            <span>创建时间</span>
          </div>
          {jobs.map((j) => (
            <div className="dm-job-row" key={j.id}>
              <span style={{ fontWeight: 500 }}>{j.tenant_name}</span>
              <span>{j.kind}</span>
              <Badge tone={j.status === "running" ? "warning" : j.status === "completed" ? "success" : "neutral"}>{j.status}</Badge>
              <div className="dm-bar" style={{ width: 120 }}>
                <span className={j.status === "running" ? "warning" : "success"} style={{ width: `${j.progress}%` }} />
              </div>
              <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{new Date(j.created_at).toLocaleString()}</span>
            </div>
          ))}
        </Panel>
      </div>
    </>
  );
}
