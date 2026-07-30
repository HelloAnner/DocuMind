"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, FileText, Upload, X } from "lucide-react";
import {
  getAdminDocument,
  uploadAdminDocumentWithProgress,
  type AdminDocument,
  type UploadDocumentResponse,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatSize, statusLabel, statusTone } from "@/components/ui/document-drawer";
import { IconButton } from "@/components/ui/icon-button";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(["docx", "pptx", "pdf", "txt", "md", "markdown"]);
const ACTIVE_PARSE_STATUSES = new Set(["uploaded", "parsing", "embedding", "ocr_pending"]);
const SETTLING_PARSE_STATUSES = new Set(["parsed", "cleaned", "chunked"]);

type UploadPhase = "idle" | "ready" | "uploading" | "uploaded" | "error";

interface TransferProgress {
  loaded: number;
  total: number;
  percent: number;
}

function fileExtension(fileName: string): string {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function validateFile(file: File): string | undefined {
  if (!SUPPORTED_EXTENSIONS.has(fileExtension(file.name))) {
    return "仅支持 DOCX、PPTX、PDF、TXT 和 Markdown 文件";
  }
  if (file.size > MAX_UPLOAD_BYTES) return "单个文件不能超过 100MB";
  if (file.size === 0) return "不能上传空文件";
  return undefined;
}

export function AdminDocumentUploadModal({
  kbId,
  kbName,
  onClose,
  onUploaded,
}: {
  kbId: string;
  kbName: string;
  onClose: () => void;
  onUploaded: () => Promise<void> | void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File>();
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState("选择文件后开始上传");
  const [progress, setProgress] = useState<TransferProgress>({ loaded: 0, total: 0, percent: 0 });
  const [uploadResult, setUploadResult] = useState<UploadDocumentResponse>();
  const [document, setDocument] = useState<AdminDocument>();

  useEffect(() => {
    const docId = uploadResult?.document_id;
    if (!docId) return;
    let stopped = false;
    let settlingChecks = 0;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const detail = await getAdminDocument(docId);
        if (stopped) return;
        setDocument(detail.document);
        const parseStatus = detail.document.parse_status;
        if (ACTIVE_PARSE_STATUSES.has(parseStatus)) {
          timer = window.setTimeout(poll, 1800);
        } else if (SETTLING_PARSE_STATUSES.has(parseStatus) && settlingChecks < 2) {
          settlingChecks += 1;
          timer = window.setTimeout(poll, 1800);
        }
      } catch (error) {
        if (!stopped) {
          setMessage(error instanceof Error ? error.message : "解析状态获取失败");
        }
      }
    };

    poll().catch(console.error);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [uploadResult?.document_id]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  function selectFile(nextFile: File | undefined) {
    if (!nextFile || phase === "uploading") return;
    const validationError = validateFile(nextFile);
    setUploadResult(undefined);
    setDocument(undefined);
    setProgress({ loaded: 0, total: nextFile.size, percent: 0 });
    setFile(nextFile);
    if (validationError) {
      setPhase("error");
      setMessage(validationError);
      return;
    }
    setPhase("ready");
    setMessage("文件已就绪，可以开始上传");
  }

  function resetUpload() {
    if (phase === "uploading") return;
    setFile(undefined);
    setPhase("idle");
    setMessage("选择文件后开始上传");
    setProgress({ loaded: 0, total: 0, percent: 0 });
    setUploadResult(undefined);
    setDocument(undefined);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleUpload() {
    if (!file || phase === "uploading") return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("uploading");
    setMessage("正在上传文件，请保持页面开启");
    setProgress({ loaded: 0, total: file.size, percent: 0 });
    try {
      const result = await uploadAdminDocumentWithProgress(
        kbId,
        file,
        (nextProgress) => {
          setProgress(nextProgress);
          if (nextProgress.percent === 100) setMessage("文件传输完成，服务器正在保存");
        },
        controller.signal
      );
      setProgress((current) => ({
        loaded: current.total || file.size,
        total: current.total || file.size,
        percent: 100,
      }));
      setUploadResult(result);
      setPhase("uploaded");
      setMessage("文件上传完成，后台解析任务已创建");
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      setPhase(aborted ? "ready" : "error");
      setMessage(aborted ? "上传已取消，可以重新开始" : error instanceof Error ? error.message : "上传失败");
    } finally {
      abortRef.current = null;
    }
  }

  const progressTone = phase === "error" ? "danger" : phase === "uploaded" ? "success" : "dark";
  const status = document ? statusLabel(document.parse_status) : undefined;

  return (
    <div className="dm-modal-overlay" onClick={onClose}>
      <div className="dm-modal dm-upload-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dm-modal-head">
          <h2>上传文档</h2>
          <IconButton onClick={onClose} aria-label="关闭">
            <X size={18} />
          </IconButton>
        </div>

        <div className="dm-upload-intro">
          <span>目标知识库</span>
          <div>
            <strong>{kbName}</strong>
            <p>文档上传后会自动进入解析、切片和索引流程。</p>
          </div>
        </div>

        <button
          className={`dm-upload-drop-zone${dragging ? " is-dragging" : ""}`}
          disabled={phase === "uploading"}
          onClick={() => fileInputRef.current?.click()}
          onDragEnter={(event) => {
            event.preventDefault();
            if (phase !== "uploading") setDragging(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            selectFile(event.dataTransfer.files?.[0]);
          }}
          type="button"
        >
          <span className="dm-upload-drop-icon">
            <Upload size={24} />
          </span>
          <strong>{file ? "重新选择文件" : "选择文件或拖放到这里"}</strong>
          <span>支持 DOCX / PPTX / PDF / TXT / Markdown，单个文件不超过 100MB</span>
        </button>

        <input
          accept=".docx,.pptx,.pdf,.txt,.md,.markdown"
          hidden
          onChange={(event) => selectFile(event.target.files?.[0])}
          ref={fileInputRef}
          type="file"
        />

        <section className="dm-upload-file-card" aria-label="待上传文件">
          <div className="dm-upload-file-main">
            <span className="dm-upload-file-icon">
              {phase === "uploaded" ? <CheckCircle2 size={20} /> : <FileText size={20} />}
            </span>
            <div>
              <strong>{file?.name ?? "尚未选择文件"}</strong>
              <span>{file ? `${fileExtension(file.name).toUpperCase()} · ${formatSize(file.size)}` : "选择文件后将在这里核对信息"}</span>
            </div>
          </div>
          <div className="dm-upload-file-actions">
            {file && phase !== "uploading" && phase !== "uploaded" ? (
              <button aria-label="移除已选文件" className="dm-icon-button" onClick={resetUpload} type="button">
                <X size={16} />
              </button>
            ) : null}
            {phase === "uploading" ? (
              <Button onClick={() => abortRef.current?.abort()} variant="secondary">
                取消上传
              </Button>
            ) : phase === "uploaded" ? (
              <Button onClick={resetUpload} variant="secondary">
                继续上传
              </Button>
            ) : (
              <Button disabled={!file || phase === "error"} onClick={() => handleUpload().catch(console.error)}>
                开始上传
              </Button>
            )}
          </div>
        </section>

        <section className="dm-upload-progress-panel" aria-label="文件上传进度">
          <div className="dm-upload-progress-head">
            <div>
              <span>上传进度</span>
              <strong>{message}</strong>
            </div>
            <strong>{progress.percent}%</strong>
          </div>
          <div
            aria-label={`已上传 ${progress.percent}%`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progress.percent}
            className="dm-bar dm-upload-real-progress"
            role="progressbar"
          >
            <span className={progressTone} style={{ width: `${progress.percent}%` }} />
          </div>
          <div className="dm-upload-progress-meta">
            <span>
              {progress.total > 0
                ? `${formatSize(Math.min(progress.loaded, progress.total))} / ${formatSize(progress.total)}`
                : "等待开始"}
            </span>
            <span>进度来自浏览器实际传输事件</span>
          </div>
          {uploadResult ? (
            <div className="dm-upload-processing-status" role="status">
              <div>
                <span>解析状态</span>
                <strong>{document ? `任务 ${document.latest_parse_job_id?.slice(0, 8) ?? uploadResult.parse_job_id.slice(0, 8)}` : `任务 ${uploadResult.parse_job_id.slice(0, 8)}`}</strong>
              </div>
              <Badge tone={document ? statusTone(document.parse_status) : "warning"}>{status ?? "等待解析"}</Badge>
            </div>
          ) : null}
        </section>

        <div className="dm-modal-actions">
          {phase === "uploaded" ? (
            <Button
              onClick={() => {
                onUploaded();
                onClose();
              }}
              variant="primary"
            >
              完成并返回列表
            </Button>
          ) : (
            <Button onClick={onClose} variant="secondary">
              关闭
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}