"use client";

import { Download, ExternalLink, Quote, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  fetchFilePreviewBlob,
  getFilePreview,
  getFilePreviewUrl,
} from "@/lib/api";
import type { Citation } from "@/lib/types";
import { ErrorBoundary } from "@/components/error-boundary";
import { DocumentViewer } from "./document-viewer";

interface DocumentPreviewProps {
  target: DocumentPreviewTarget;
  conversationId?: string;
}

export interface DocumentPreviewTarget {
  doc_id: string;
  doc_title: string;
  file_type?: string;
  page_range?: number[];
  source_status?: "available" | "deleted" | string;
  anchor?: Citation["anchor"];
  citation_id?: string;
  index?: number;
  quote?: string;
}

export function previewTargetFromCitation(citation: Citation): DocumentPreviewTarget {
  return {
    doc_id: citation.doc_id,
    doc_title: citation.doc_title,
    page_range: citation.page_range,
    source_status: citation.source_status,
    anchor: citation.anchor,
    citation_id: citation.citation_id,
    index: citation.index,
    quote: citation.quote,
  };
}

type PreviewState =
  | { status: "loading" }
  | {
      status: "ready";
      blobUrl: string;
      mimeType: string;
      fileName: string;
      parseJobId?: string;
      sourceUrl: string;
    }
  | { status: "failed"; error: string };

function fileType(target: DocumentPreviewTarget) {
  const explicit = target.file_type || target.anchor?.format;
  if (explicit) return explicit.toLowerCase();
  const title = target.doc_title.toLowerCase();
  if (title.endsWith(".pdf")) return "pdf";
  if (title.endsWith(".pptx") || title.endsWith(".ppt")) return "pptx";
  if (title.endsWith(".docx") || title.endsWith(".doc")) return "docx";
  if (title.endsWith(".md")) return "md";
  return "txt";
}

function mimeTypeFromType(type: string, blob: Blob): string {
  if (blob.type && blob.type !== "application/octet-stream") return blob.type;
  if (type === "pdf") return "application/pdf";
  if (type === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (type === "pptx") {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  if (type === "md" || type === "txt") return "text/plain";
  return "application/octet-stream";
}

export function previewTargetPage(target: DocumentPreviewTarget) {
  return target.anchor?.page ?? target.anchor?.slide ?? target.page_range?.[0] ?? null;
}

function targetLocationStatus(target: DocumentPreviewTarget) {
  if (target.source_status === "deleted") return "unavailable";
  if (target.anchor?.location_status === "structural_only") return "file_only";
  return target.anchor?.location_status ?? (previewTargetPage(target) ? "page_only" : "file_only");
}

function locationStatusCopy(status: string) {
  switch (status) {
    case "exact":
      return { label: "精确定位", detail: "已按原文证据定位并高亮" };
    case "page_only":
      return { label: "页码定位", detail: "已打开对应页面，当前解析结果没有高亮坐标" };
    case "slide_only":
      return { label: "幻灯片定位", detail: "已打开对应幻灯片，当前解析结果没有高亮坐标" };
    case "file_only":
      return { label: "原文文件", detail: "当前文档只能打开原文，不能精确定位" };
    default:
      return { label: "来源不可用", detail: "原文已删除、无权限或解析版本不可用" };
  }
}

export function DocumentPreview({ target, conversationId }: DocumentPreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [slow, setSlow] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [actionError, setActionError] = useState("");
  const type = fileType(target);
  const page = previewTargetPage(target);
  const requestedStatus = targetLocationStatus(target);

  useEffect(() => {
    const controller = new AbortController();
    let currentBlobUrl: string | undefined;
    let timedOut = false;
    setState({ status: "loading" });
    setSlow(false);
    setActionError("");

    if (requestedStatus === "unavailable") {
      setState({ status: "failed", error: locationStatusCopy(requestedStatus).detail });
      return () => controller.abort();
    }

    const slowTimer = window.setTimeout(() => setSlow(true), 5_000);
    const timeoutTimer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
      setState({ status: "failed", error: "原文加载超时，请重试。" });
    }, 15_000);

    void Promise.all([
      getFilePreview(target.doc_id, conversationId, controller.signal),
      getFilePreviewUrl(target.doc_id, conversationId, controller.signal),
    ])
      .then(async ([preview, signed]) => {
        if (preview.source_status === "unavailable") throw new Error("来源不可用");
        const pdfPreview = type === "pdf" || preview.preview_type === "office_pdf";
        if (pdfPreview) {
          return {
            blobUrl: "",
            mimeType: "application/pdf",
            fileName: preview.file_name || target.doc_title,
            parseJobId: preview.parse_job_id,
            sourceUrl: signed.preview_url,
          };
        }
        const blob = await fetchFilePreviewBlob(target.doc_id, conversationId, controller.signal);
        const mime = mimeTypeFromType(type, blob);
        currentBlobUrl = URL.createObjectURL(new Blob([blob], { type: mime }));
        return {
          blobUrl: currentBlobUrl,
          mimeType: mime,
          fileName: preview.file_name || target.doc_title,
          parseJobId: preview.parse_job_id,
          sourceUrl: signed.preview_url,
        };
      })
      .then((ready) => {
        if (!controller.signal.aborted) setState({ status: "ready", ...ready });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || timedOut) return;
        console.error("[DocumentPreview] load failed", error);
        setState({ status: "failed", error: "原文加载失败，请重试或下载原文查看。" });
      })
      .finally(() => {
        window.clearTimeout(slowTimer);
        window.clearTimeout(timeoutTimer);
        if (!controller.signal.aborted) setSlow(false);
      });

    return () => {
      controller.abort();
      window.clearTimeout(slowTimer);
      window.clearTimeout(timeoutTimer);
      if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    };
  }, [conversationId, requestedStatus, retryToken, target.doc_id, target.doc_title, type]);

  const versionMatches = state.status !== "ready"
    || !target.anchor?.parse_job_id
    || !state.parseJobId
    || target.anchor.parse_job_id === state.parseJobId;
  const effectiveStatus = requestedStatus === "exact" && !versionMatches
    ? page
      ? "page_only"
      : "file_only"
    : requestedStatus;
  const statusCopy = locationStatusCopy(effectiveStatus);
  const exactAnchorBox = effectiveStatus === "exact" ? target.anchor?.bbox : undefined;
  const charRange = effectiveStatus === "exact" ? target.anchor?.char_range : undefined;
  const quote = target.quote?.trim();

  const locationLabel = useMemo(() => {
    if (page && target.anchor?.slide) return `第 ${page} 张`;
    if (page) return `第 ${page} 页`;
    return "原文";
  }, [page, target.anchor?.slide]);

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    setActionError("");
    try {
      const blob = await fetchFilePreviewBlob(target.doc_id, conversationId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = state.status === "ready" ? state.fileName : target.doc_title;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setActionError("原文下载失败，请重试");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="dm-original-document-preview">
      <section className="dm-document-context" aria-label="引用依据">
        <div className="dm-document-context-meta">
          <span className={`dm-location-status dm-location-status-${effectiveStatus}`}>
            <strong>{statusCopy.label}</strong>
          </span>
          <span>{locationLabel}</span>
          {target.index ? <span>引用 [{target.index}]</span> : null}
        </div>
        {quote ? (
          <blockquote>
            <Quote size={14} aria-hidden="true" />
            <span>{quote}</span>
          </blockquote>
        ) : null}
        <div className="dm-document-context-footer">
          <span>{statusCopy.detail}</span>
          <div className="dm-document-context-actions">
            <button disabled={downloading} onClick={() => void download()} type="button">
              <Download size={14} />
              {downloading ? "下载中…" : "下载"}
            </button>
            {state.status === "ready" ? (
              <a href={state.sourceUrl} rel="noreferrer" target="_blank">
                <ExternalLink size={14} />
                新窗口
              </a>
            ) : null}
          </div>
        </div>
        {actionError ? <span className="dm-document-action-error" role="alert">{actionError}</span> : null}
      </section>

      <div className="dm-document-preview-body">
        {state.status === "loading" ? (
          <div className="dm-document-loading" role="status">
            <span>正在打开原文…</span>
            {slow ? <small>文件较大，仍在加载</small> : null}
          </div>
        ) : null}
        {state.status === "failed" ? (
          <div className="dm-document-error" role="alert">
            <strong>无法打开原文</strong>
            <span>{state.error}</span>
            <button onClick={() => setRetryToken((value) => value + 1)} type="button">
              <RefreshCw size={15} />
              重试
            </button>
          </div>
        ) : null}
        {state.status === "ready" ? (
          <ErrorBoundary>
            <DocumentViewer
              blobUrl={state.blobUrl}
              docId={state.mimeType === "application/pdf" ? target.doc_id : undefined}
              conversationId={conversationId}
              mimeType={state.mimeType}
              fileName={state.fileName}
              initialPage={page}
              anchorBox={exactAnchorBox ?? undefined}
              charRange={charRange ?? undefined}
            />
          </ErrorBoundary>
        ) : null}
      </div>
    </div>
  );
}
