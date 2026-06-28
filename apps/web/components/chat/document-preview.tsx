"use client";

import { useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { fetchFilePreviewBlob, getFilePreview } from "@/lib/api";
import type { Citation } from "@/lib/types";
import { ErrorBoundary } from "@/components/error-boundary";
import { DocumentViewer } from "./document-viewer";

interface DocumentPreviewProps {
  citation: Citation;
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

function fileType(citation: Citation) {
  const explicit = citation.anchor?.format;
  if (explicit) return explicit.toLowerCase();
  const title = citation.doc_title.toLowerCase();
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

function targetPage(citation: Citation) {
  return citation.anchor?.page ?? citation.anchor?.slide ?? citation.page_range[0] ?? null;
}

function locationStatus(citation: Citation) {
  if (citation.source_status === "deleted") return "unavailable";
  return citation.anchor?.location_status ?? "unavailable";
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
    default:
      return {
        label: "不可定位",
        detail: "原文已删除、无权限或解析版本不可用。",
      };
  }
}

function citationAnchorBox(citation: Citation) {
  return citation.anchor?.bbox ?? null;
}

function citationCharRange(citation: Citation) {
  return citation.anchor?.char_range ?? null;
}

export function DocumentPreview({ citation }: DocumentPreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const type = fileType(citation);
  const page = targetPage(citation);
  const status = locationStatus(citation);
  const statusCopy = locationStatusCopy(status);
  const anchorBox = useMemo(() => citationAnchorBox(citation), [citation]);
  const exactAnchorBox = status === "exact" ? anchorBox : null;
  const charRange = useMemo(() => citationCharRange(citation), [citation]);
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

    getFilePreview(citation.doc_id)
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
            fileName: preview.file_name || citation.doc_title,
          });
          return null;
        }
        return fetchFilePreviewBlob(citation.doc_id).then((blob) => ({ blob, preview }));
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
          fileName: preview.file_name || citation.doc_title,
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
  }, [citation.doc_id, type, citation.doc_title, canOpenSource, statusCopy.detail]);

  return (
    <div className="dm-original-document-preview">
      <div className="dm-document-preview-header">
        <div className="dm-document-preview-title">
          <FileText className="dm-document-preview-icon" size={18} />
          <div className="dm-document-preview-meta">
            <strong>{citation.doc_title}</strong>
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
              docId={state.mimeType === "application/pdf" ? citation.doc_id : undefined}
              cacheKey={citation.doc_id}
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
