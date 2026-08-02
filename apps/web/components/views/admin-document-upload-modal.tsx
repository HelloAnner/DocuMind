"use client";

import { useMemo, useRef, useState } from "react";
import { CheckCircle2, FileText, Upload, X } from "lucide-react";
import { uploadAdminDocumentWithProgress } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { formatSize } from "@/components/ui/document-drawer";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 50;
const UPLOAD_CONCURRENCY = 3;
const SUPPORTED_EXTENSIONS = new Set(["docx", "pptx", "pdf", "txt", "md", "markdown"]);

type ItemStatus = "ready" | "uploading" | "queued" | "failed" | "cancelled";
type UploadItem = { id: string; file: File; status: ItemStatus; percent: number; error?: string; documentId?: string; jobId?: string; controller?: AbortController };

function extension(name: string) { return name.split(".").pop()?.toLowerCase() ?? ""; }
function validation(file: File) {
  if (!SUPPORTED_EXTENSIONS.has(extension(file.name))) return "不支持该文件格式";
  if (!file.size) return "文件为空";
  if (file.size > MAX_UPLOAD_BYTES) return "单个文件不能超过 100MB";
}

export function AdminDocumentUploadModal({ kbId, kbName, onClose, onUploaded }: { kbId: string; kbName: string; onClose: () => void; onUploaded: () => void | Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const batchIdRef = useRef(crypto.randomUUID());

  function addFiles(files: FileList | File[]) {
    const selected = Array.from(files);
    setItems((current) => {
      const available = Math.max(0, MAX_FILES - current.length);
      const existing = new Set(current.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`));
      return [...current, ...selected.filter((file) => !existing.has(`${file.name}:${file.size}:${file.lastModified}`)).slice(0, available).map((file) => {
        const error = validation(file);
        return { id: crypto.randomUUID(), file, status: error ? "failed" as const : "ready" as const, percent: 0, error };
      })];
    });
  }

  function patch(id: string, update: Partial<UploadItem>) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, ...update } : item));
  }

  async function uploadOne(item: UploadItem) {
    const controller = new AbortController();
    patch(item.id, { status: "uploading", percent: 0, error: undefined, controller });
    try {
      const result = await uploadAdminDocumentWithProgress(kbId, item.file, (progress) => patch(item.id, { percent: progress.percent }), controller.signal, batchIdRef.current);
      patch(item.id, { status: "queued", percent: 100, controller: undefined, documentId: result.document_id, jobId: result.parse_job_id });
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      patch(item.id, { status: cancelled ? "cancelled" : "failed", controller: undefined, error: cancelled ? "已取消" : error instanceof Error ? error.message : "上传失败" });
    }
  }

  async function startUpload() {
    const queue = items.filter((item) => item.status === "ready" || item.status === "cancelled" || (item.status === "failed" && !validation(item.file)));
    if (!queue.length) return;
    setRunning(true);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, async () => {
      while (cursor < queue.length) {
        const item = queue[cursor++];
        await uploadOne(item);
      }
    }));
    setRunning(false);
    await onUploaded();
  }

  const counts = useMemo(() => items.reduce((value, item) => ({ ...value, [item.status]: value[item.status] + 1 }), { ready: 0, uploading: 0, queued: 0, failed: 0, cancelled: 0 } as Record<ItemStatus, number>), [items]);
  const totalProgress = items.length ? Math.round(items.reduce((sum, item) => sum + item.percent, 0) / items.length) : 0;
  const close = () => { items.forEach((item) => item.controller?.abort()); onClose(); };

  return <div className="dm-modal-overlay" onClick={close}>
    <div className="dm-modal dm-upload-modal dm-batch-upload-modal" onClick={(event) => event.stopPropagation()}>
      <div className="dm-modal-head"><div><h2>批量上传文档</h2><p>上传到“{kbName}” · 单次最多 {MAX_FILES} 个文件</p></div><button className="dm-icon-button" aria-label="关闭" onClick={close} type="button"><X size={18} /></button></div>
      <button className={`dm-upload-drop-zone${dragging ? " is-dragging" : ""}`} disabled={running} onClick={() => inputRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { event.preventDefault(); setDragging(false); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }} type="button">
        <span className="dm-upload-drop-icon"><Upload size={24} /></span><strong>选择多个文件或拖放到这里</strong><span>DOCX / PPTX / PDF / TXT / Markdown，单个文件不超过 100MB</span>
      </button>
      <input accept=".docx,.pptx,.pdf,.txt,.md,.markdown" hidden multiple onChange={(event) => event.target.files && addFiles(event.target.files)} ref={inputRef} type="file" />
      {items.length ? <>
        <div className="dm-batch-upload-summary"><div><strong>共 {items.length} 个文件</strong><span>已入队 {counts.queued} · 上传中 {counts.uploading} · 等待 {counts.ready + counts.cancelled} · 失败 {counts.failed}</span></div><strong>{totalProgress}%</strong></div>
        <div className="dm-bar"><span className={counts.failed ? "danger" : "dark"} style={{ width: `${totalProgress}%` }} /></div>
        <div className="dm-batch-upload-list">{items.map((item) => <article key={item.id}>
          <span className="dm-upload-file-icon">{item.status === "queued" ? <CheckCircle2 size={18} /> : <FileText size={18} />}</span>
          <div><strong>{item.file.name}</strong><small>{formatSize(item.file.size)} · {item.error ?? ({ ready: "等待上传", uploading: `上传中 ${item.percent}%`, queued: `已入队 · ${item.jobId?.slice(0, 8)}`, failed: "上传失败", cancelled: "已取消" }[item.status])}</small>{item.status === "uploading" ? <div className="dm-bar"><span className="dark" style={{ width: `${item.percent}%` }} /></div> : null}</div>
          {item.status === "uploading" ? <button className="dm-row-action" onClick={() => item.controller?.abort()} type="button">取消</button> : item.status !== "queued" && !running ? <button className="dm-row-action danger" onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))} type="button">移除</button> : null}
        </article>)}</div>
      </> : null}
      <div className="dm-modal-actions"><Button variant="secondary" onClick={close}>{counts.queued ? "关闭" : "取消"}</Button><Button disabled={running || !items.some((item) => item.status !== "queued" && !validation(item.file))} onClick={() => startUpload().catch(console.error)}>{running ? "正在上传" : counts.queued ? "上传剩余文件" : "开始上传"}</Button></div>
    </div>
  </div>;
}
