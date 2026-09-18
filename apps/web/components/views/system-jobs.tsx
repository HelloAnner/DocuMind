"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Clock3, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson } from "@/lib/api";

interface Job {
  id: string;
  tenant_name: string;
  kind: string;
  title: string;
  status: "queued" | "running";
  progress: number | null;
  queue_position: number | null;
  attempt_count: number;
  max_attempts: number;
  worker_id: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
}

interface JobQueue {
  checked_at: string;
  queued: number;
  running: number;
  jobs: Job[];
}

const kindLabel: Record<string, string> = {
  document_parse: "文档解析",
  document_ocr: "OCR 识别",
  vector_index_document: "文档向量化",
  vector_rebuild_index: "索引重建",
};

export function SystemJobs() {
  const [queue, setQueue] = useState<JobQueue>();
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (showBusy = false) => {
    if (showBusy) setRefreshing(true);
    try {
      setQueue(await fetchJson<JobQueue>("/api/system/jobs"));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务队列读取失败");
    } finally {
      if (showBusy) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(console.error);
    const timer = window.setInterval(() => refresh().catch(console.error), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <>
      <Topbar title="实时任务队列">
        <Button
          disabled={refreshing}
          icon={<RefreshCw size={14} />}
          onClick={() => refresh(true).catch(console.error)}
          variant="secondary"
        >
          刷新
        </Button>
      </Topbar>
      <div className="dm-admin-content dm-ops-page">
        <div className="dm-stat-row">
          <StatCard label="处理中" value={String(queue?.running ?? "-")} hint="当前被 Worker 领取" />
          <StatCard label="排队中" value={String(queue?.queued ?? "-")} hint="等待执行" />
          <StatCard
            label="数据时间"
            value={queue ? new Date(queue.checked_at).toLocaleTimeString() : "-"}
            hint="每 3 秒自动刷新"
          />
        </div>
        {error ? <div className="dm-error-banner" role="alert">{error}</div> : null}

        <Panel
          className="dm-ops-panel"
          title="当前任务"
          action={<span>仅显示真实的排队中与处理中任务</span>}
        >
          {!queue ? <div className="dm-empty-state">正在读取任务队列...</div> : null}
          {queue && queue.jobs.length === 0 ? (
            <div className="dm-ops-empty">
              <span><Activity size={20} /></span>
              <strong>当前没有任务</strong>
              <p>数据库中没有等待执行或正在处理的解析、OCR、向量化任务。</p>
            </div>
          ) : null}
          {queue?.jobs.map((job) => (
            <div className="dm-live-job" key={job.id}>
              <div className={`dm-live-job-state ${job.status}`}>
                {job.status === "running" ? <Activity size={16} /> : <Clock3 size={16} />}
              </div>
              <div className="dm-live-job-main">
                <div>
                  <strong>{job.title}</strong>
                  <Badge tone={job.status === "running" ? "warning" : "neutral"}>
                    {job.status === "running" ? "处理中" : `排队 #${job.queue_position}`}
                  </Badge>
                </div>
                <p>{job.tenant_name} · {kindLabel[job.kind] ?? job.kind}</p>
              </div>
              <div className="dm-live-job-progress">
                {job.progress === null ? (
                  <span>未报告进度</span>
                ) : (
                  <>
                    <div className="dm-bar"><span className="warning" style={{ width: `${job.progress}%` }} /></div>
                    <span>{job.progress}%</span>
                  </>
                )}
              </div>
              <div className="dm-live-job-meta">
                <span>{job.attempt_count} / {job.max_attempts} 次</span>
                <small>{job.worker_id ? `Worker ${job.worker_id}` : "尚未分配 Worker"}</small>
              </div>
              <time dateTime={job.updated_at}>{new Date(job.updated_at).toLocaleString()}</time>
            </div>
          ))}
        </Panel>
      </div>
    </>
  );
}
