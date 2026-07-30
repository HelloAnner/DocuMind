"use client";

import { useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { fetchFilePreviewBlob, getFilePreview } from "@/lib/api";
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
}

export function previewTargetFromCitation(citation: Citation): DocumentPreviewTarget {
  return {
    doc_id: citation.doc_id,
    doc_title: citation.doc_title,
    page_range: citation.page_range,
    source_status: citation.source_status,
    anchor: citation.anchor,
  };
}

type PreviewState =
  | { status: "loading"; blobUrl?: undefined; error?: undefined; mimeType?: undefined }
  | {
      status: "ready";
      blobUrl: string;
      mimeType: string;
      fileName: string;
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
  if (blob.type && blob.type !== "application/octet-stream") {
    return blob.type;
  }
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

function targetPage(target: DocumentPreviewTarget) {
  return target.anchor?.page ?? target.anchor?.slide ?? target.page_range?.[0] ?? null;
}

function locationStatus(target: DocumentPreviewTarget) {
  if (target.source_status === "deleted") return "unavailable";
  if (target.anchor?.location_status) return target.anchor.location_status;
  if (targetPage(target)) return "page_only";
  return "available";
}

function locationStatusCopy(status: string) {
  switch (status) {
    case "exact":
      return {
        label: "精确定位",
        detail: "已按原文锚点定位并高亮。",
      };
    case "structural_only":
      return {
        label: "结构定位",
        detail: "",
      };
    case "page_only":
      return {
        label: "仅页码",
        detail: "只能打开对应页，未获得可高亮的原文坐标。",
      };
    case "slide_only":
      return {
        label: "仅幻灯片",
        detail: "只能打开对应幻灯片，未获得可高亮的原文坐标。",
      };
    case "available":
      return {
        label: "完整文件",
        detail: "从文件开头打开真实原文。",
      };
    default:
      return {
        label: "不可定位",
        detail: "原文已删除、无权限或解析版本不可用。",
      };
  }
}

function citationAnchorBox(target: DocumentPreviewTarget) {
  return target.anchor?.bbox ?? null;
}

function citationCharRange(target: DocumentPreviewTarget) {
  return target.anchor?.char_range ?? null;
}

export function DocumentPreview({ target, conversationId }: DocumentPreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const type = fileType(target);
  const page = targetPage(target);
  const status = locationStatus(target);
  const statusCopy = locationStatusCopy(status);
  const anchorBox = useMemo(() => citationAnchorBox(target), [target]);
  const exactAnchorBox = status === "exact" ? anchorBox : null;
  const charRange = useMemo(() => citationCharRange(target), [target]);
  const canOpenSource = status !== "unavailable";

  useEffect(() => {
    let revoked = false;
    let currentBlobUrl: string | undefined;
    setState({ status: "loading" });

    if (!canOpenSource) {
      setState({ status: "failed", error: statusCopy.detail });
      return () => {
        revoked = true;
      };
    }

    getFilePreview(target.doc_id, conversationId)
      .then((preview) => {
        if (revoked) return;
        if (preview.source_status === "unavailable") {
          throw new Error("来源不可用");
        }
        if (type === "pdf" || preview.preview_type === "office_pdf") {
          setState({
            status: "ready",
            blobUrl: "",
            mimeType: "application/pdf",
            fileName: preview.file_name || target.doc_title,
          });
          return null;
        }
        return fetchFilePreviewBlob(target.doc_id, conversationId).then((blob) => ({
          blob,
          preview,
        }));
      })
      .then((result) => {
        if (revoked || result == null) return;
        const { blob, preview } = result;
        const mime = mimeTypeFromType(type, blob);
        const typedBlob = new Blob([blob], { type: mime });
        currentBlobUrl = URL.createObjectURL(typedBlob);
        setState({
          status: "ready",
          blobUrl: currentBlobUrl,
          mimeType: mime,
          fileName: preview.file_name || target.doc_title,
        });
      })
      .catch((error: unknown) => {
        if (!revoked) {
          setState({
            status: "failed",
            error: error instanceof Error ? error.message : "原文文件加载失败",
          });
        }
      });

    return () => {
      revoked = true;
      if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    };
  }, [
    target.doc_id,
    type,
    target.doc_title,
    canOpenSource,
    statusCopy.detail,
    conversationId,
  ]);

  return (
    <div className="dm-original-document-preview">
      <div className="dm-document-preview-header">
        <div className="dm-document-preview-title">
          <FileText className="dm-document-preview-icon" size={18} />
          <div className="dm-document-preview-meta">
            <strong>{target.doc_title}</strong>
            {page ? <span>第 {page} 页</span> : null}
          </div>
        </div>
        <div className={`dm-location-status dm-location-status-${status}`}>
          <strong>{statusCopy.label}</strong>
          {statusCopy.detail ? <span>{statusCopy.detail}</span> : null}
        </div>
      </div>

      <div className="dm-document-preview-body">
        {state.status === "loading" && (
          <div className="dm-document-loading">正在打开原文…</div>
        )}
        {state.status === "failed" && (
          <div className="dm-document-error">{state.error || "原始文件暂不可预览。"}</div>
        )}
        {state.status === "ready" && (
          <ErrorBoundary>
            <DocumentViewer
              blobUrl={state.blobUrl}
              docId={state.mimeType === "application/pdf" ? target.doc_id : undefined}
              cacheKey={target.doc_id}
              conversationId={conversationId}
              mimeType={state.mimeType}
              fileName={state.fileName}
              initialPage={page}
              anchorBox={exactAnchorBox ?? undefined}
              charRange={charRange ?? undefined}
            />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
