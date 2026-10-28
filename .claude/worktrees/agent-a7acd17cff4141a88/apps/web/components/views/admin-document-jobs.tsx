"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, FileText, RefreshCw, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { StatCard } from "@/components/ui/stat-card";
import { Topbar } from "@/components/ui/topbar";
import { formatSize } from "@/components/ui/document-drawer";
import {
  getDocumentJob,
  listDocumentJobs,
  retryAdminDocument,
  type DocumentJob,
  type DocumentJobDetail,
  type DocumentJobsResponse,
} from "@/lib/api";

const filters = [
  ["all", "全部"], ["queued", "排队中"], ["processing", "处理中"],
  ["failed", "异常"], ["completed", "已完成"], ["warning", "需关注"],
] as const;

const stageLabels: Record<string, string> = {
  waiting_parse: "等待解析", parsing: "文档解析", chunking: "清洗与切片",
  embedding: "向量化", indexed: "写入索引", ocr: "OCR 增强", quality_review: "质量复核",
};
const statusLabels: Record<string, string> = {
  queued: "排队中", processing: "处理中", completed: "已完成", warning: "需关注", failed: "失败",
  running: "处理中",
};

function tone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "queued") return "neutral";
  return "warning";
}

function elapsed(job: DocumentJob) {
  const start = new Date(job.started_at ?? job.created_at).getTime();
  const end = job.completed_at ? new Date(job.completed_at).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}

export function AdminDocumentJobs() {
  const [data, setData] = useState<DocumentJobsResponse>();
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async (busy = false) => {
    if (busy) setLoading(true);
    try {
      setData(await listDocumentJobs({ status: filter, q: query.trim() || undefined, limit: 200 }));
      setError(undefined);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "文档处理记录加载失败");
    } finally {
      setLoading(false);
    }
  }, [filter, query]);

  useEffect(() => { refresh(true).catch(console.error); }, [refresh]);
  const active = Boolean(data?.summary.queued || data?.summary.processing);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => refresh().catch(console.error), 3000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const rows = useMemo(() => data?.items ?? [], [data]);
  return <>
    <Topbar title="文档处理" subtitle="查看当前租户文档的排队、解析、向量化和索引状态">
      <Button icon={<RefreshCw size={14} />} variant="secondary" onClick={() => refresh(true).catch(console.error)}>刷新</Button>
    </Topbar>
    <div className="dm-admin-content dm-document-jobs-page">
      <section className="dm-stat-row">
        <StatCard label="处理中" value={String(data?.summary.processing ?? "-")} hint={data?.summary.stalled ? `${data.summary.stalled} 个长时间无进展` : "运行正常"} />
        <StatCard label="排队中" value={String(data?.summary.queued ?? "-")} hint="等待解析资源" />
        <StatCard label="近 24 小时失败" value={String(data?.summary.failed_24h ?? "-")} hint="可查看原因并重试" />
        <StatCard label="近 24 小时完成" value={String(data?.summary.completed_24h ?? "-")} hint="已进入检索索引" />
      </section>
      <Panel title="处理记录">
        <div className="dm-document-jobs-toolbar">
          <SearchInput placeholder="搜索文件名..." value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="dm-document-job-filters" role="tablist">
            {filters.map(([value, label]) => <button className={filter === value ? "active" : ""} key={value} onClick={() => setFilter(value)} type="button">{label}</button>)}
          </div>
        </div>
        {error ? <div className="dm-inline-error" role="alert">{error}</div> : null}
        <div className="dm-document-job-head"><span>文档</span><span>知识库 / 批次</span><span>当前阶段</span><span>状态</span><span>等待 / 耗时</span><span>结果</span></div>
        {loading ? <div className="dm-empty-state">加载处理中...</div> : null}
        {!loading && rows.length === 0 ? <div className="dm-empty-state">暂无匹配的文档处理记录</div> : null}
        {!loading ? rows.map((job) => <button className={`dm-document-job-row${job.stalled ? " is-stalled" : ""}`} key={job.job_id} onClick={() => setSelected(job.job_id)} type="button">
          <span className="dm-document-job-file"><FileText size={18} /><span><strong>{job.file_name}</strong><small>{job.file_type.toUpperCase()} · {formatSize(job.file_size)} · {job.uploaded_by ?? "未知上传人"}</small></span></span>
          <span><strong>{job.kb_name}</strong><small>{job.upload_batch_id ? `批次 ${job.upload_batch_id.slice(0, 8)}` : new Date(job.created_at).toLocaleString()}</small></span>
          <span><strong>{stageLabels[job.current_stage] ?? job.current_stage}</strong><small>{job.queue_position ? `队列第 ${job.queue_position} 位` : `任务 ${job.job_id.slice(0, 8)}`}</small></span>
          <span>{job.stalled ? <Badge tone="danger">疑似阻塞</Badge> : <Badge tone={tone(job.job_status)}>{statusLabels[job.job_status] ?? job.job_status}</Badge>}</span>
          <span><strong>{elapsed(job)}</strong><small>{job.attempt_count ? `第 ${job.attempt_count} 次尝试` : "尚未开始"}</small></span>
          <span><strong>{job.chunk_count} 切片</strong><small>{job.error_message ?? `${job.page_count ?? 0} 页 · ${job.table_count ?? 0} 表格`}</small></span>
        </button>) : null}
      </Panel>
    </div>
    {selected ? <DocumentJobDrawer jobId={selected} onClose={() => setSelected(undefined)} onChanged={() => refresh()} /> : null}
  </>;
}

function DocumentJobDrawer({ jobId, onClose, onChanged }: { jobId: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<DocumentJobDetail>();
  const [error, setError] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  const load = useCallback(async () => {
    try { setDetail(await getDocumentJob(jobId)); setError(undefined); }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : "任务详情加载失败"); }
  }, [jobId]);
  useEffect(() => { load().catch(console.error); }, [load]);
  useEffect(() => {
    if (!detail || !["queued", "processing"].includes(detail.job.job_status)) return;
    const timer = window.setInterval(() => load().catch(console.error), 3000);
    return () => window.clearInterval(timer);
  }, [detail, load]);

  async function retry() {
    if (!detail) return;
    setRetrying(true);
    try { await retryAdminDocument(detail.job.doc_id); await load(); onChanged(); }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : "重试失败"); }
    finally { setRetrying(false); }
  }

  return <div className="dm-drawer-overlay" onClick={onClose}><aside className="dm-drawer dm-document-job-drawer" onClick={(event) => event.stopPropagation()}>
    <div className="dm-drawer-head"><div className="dm-drawer-head-row"><div><h2>{detail?.job.file_name ?? "处理详情"}</h2>{detail ? <small>{detail.job.kb_name} · {detail.job.job_id}</small> : null}</div><button className="dm-icon-button" aria-label="关闭" onClick={onClose} type="button"><X size={18} /></button></div></div>
    <div className="dm-drawer-body">
      {error ? <div className="dm-inline-error">{error}</div> : null}
      {!detail ? <div className="dm-empty-state">加载中...</div> : <>
        <div className="dm-document-job-overall"><span>{detail.job.stalled ? <AlertTriangle size={20} /> : detail.job.job_status === "completed" ? <CheckCircle2 size={20} /> : <Clock3 size={20} />}</span><div><strong>{detail.job.stalled ? "疑似阻塞" : statusLabels[detail.job.job_status]}</strong><small>当前阶段：{stageLabels[detail.job.current_stage] ?? detail.job.current_stage} · {elapsed(detail.job)}</small></div></div>
        <section className="dm-document-job-timeline"><h3>处理过程</h3>{detail.events.map((event) => <article key={event.id} className={`is-${event.status}`}><span className="dm-document-job-dot" /><div><strong>{stageLabels[event.stage] ?? event.stage}</strong><p>{event.message}</p><small>{new Date(event.created_at).toLocaleString()}</small>{Object.keys(event.metrics).length ? <pre>{JSON.stringify(event.metrics, null, 2)}</pre> : null}{event.error_message ? <div className="dm-inline-error">{event.error_code}: {event.error_message}</div> : null}</div></article>)}
          {detail.vector_job && !detail.events.some((event) => event.stage === "indexed") ? <article className={`is-${detail.vector_job.status}`}><span className="dm-document-job-dot" /><div><strong>向量化与索引</strong><p>{detail.vector_job.error_message ?? statusLabels[detail.vector_job.status] ?? detail.vector_job.status}</p><small>尝试 {detail.vector_job.attempt_count} / {detail.vector_job.max_attempts}</small></div></article> : null}
        </section>
        <section className="dm-document-job-result"><h3>处理结果</h3><dl><div><dt>页数</dt><dd>{detail.job.page_count ?? "-"}</dd></div><div><dt>内容块</dt><dd>{detail.job.block_count ?? "-"}</dd></div><div><dt>表格</dt><dd>{detail.job.table_count ?? "-"}</dd></div><div><dt>切片</dt><dd>{detail.job.chunk_count}</dd></div><div><dt>质量评分</dt><dd>{detail.job.quality_score?.toFixed(2) ?? "-"}</dd></div><div><dt>尝试次数</dt><dd>{detail.job.attempt_count} / {detail.job.max_attempts}</dd></div></dl></section>
        {detail.job.job_status === "failed" || detail.job.job_status === "warning" ? <Button disabled={retrying} icon={<RotateCcw size={14} />} onClick={() => retry().catch(console.error)}>{retrying ? "正在重试" : "重新处理"}</Button> : null}
      </>}
    </div>
  </aside></div>;
}
