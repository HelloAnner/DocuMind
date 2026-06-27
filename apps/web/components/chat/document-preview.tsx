"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchAdminDocumentOriginalBlob } from "@/lib/api";
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
  return citation.anchor?.page ?? citation.page_range[0] ?? null;
}

function citationAnchorBox(citation: Citation) {
  return citation.anchor?.bbox ?? null;
}

function citationSearchText(citation: Citation) {
  const beforeFollowingContext = citation.quote.split("【下文】")[0] ?? citation.quote;
  const normalized = beforeFollowingContext
    .replace(/【上文】|【下文】/g, " ")
    .replace(/标题路径[:：][^。！？\n]*/g, " ")
    .replace(/页码[:：]\s*\d+/g, " ")
    .trim();

  const candidates = normalized
    .split(/[。！？；;|\n]+/)
    .map((segment) => segment.replace(/\s+/g, " ").trim())
    .filter((segment) => segment.length >= 6 && /[A-Za-z0-9\u4e00-\u9fff]/.test(segment));

  const chosen =
    candidates
      .slice()
      .reverse()
      .find((segment) => segment.length <= 90) ??
    candidates[candidates.length - 1] ??
    normalized.replace(/\s+/g, " ");
  const chars = Array.from(chosen);
  if (chars.length <= 80) return chosen;

  const words = chosen.split(/\s+/).filter(Boolean);
  const selected: string[] = [];
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const next = [words[index], ...selected].join(" ");
    if (Array.from(next).length > 80 && selected.length > 0) break;
    selected.unshift(words[index]);
  }
  const compact = selected.join(" ");
  return compact || chars.slice(-80).join("");
}

export function DocumentPreview({ citation }: DocumentPreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const type = fileType(citation);
  const page = targetPage(citation);
  const anchorBox = useMemo(() => citationAnchorBox(citation), [citation]);
  const searchText = useMemo(() => citationSearchText(citation), [citation]);

  useEffect(() => {
    let revoked = false;
    let currentBlobUrl: string | undefined;
    setState({ status: "loading" });

    // PDF 走服务端单页切片，不需要下载完整 Blob
    if (type === "pdf") {
      setState({
        status: "ready",
        blobUrl: "",
        mimeType: "application/pdf",
        fileName: citation.doc_title,
      });
      return () => {
        revoked = true;
      };
    }

    fetchAdminDocumentOriginalBlob(citation.doc_id)
      .then((blob) => {
        if (revoked) return;
        const mime = mimeTypeFromType(type, blob);
        const typedBlob = new Blob([blob], { type: mime });
        currentBlobUrl = URL.createObjectURL(typedBlob);
        setState({
          status: "ready",
          blobUrl: currentBlobUrl,
          mimeType: mime,
          fileName: citation.doc_title,
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
  }, [citation.doc_id, type, citation.doc_title]);

  return (
    <div className="dm-original-document-preview">
      <div className="dm-document-preview-header">
        <div className="dm-document-preview-title">
          <span className="dm-document-preview-icon">📄</span>
          <div className="dm-document-preview-meta">
            <strong>{citation.doc_title}</strong>
            {page ? <span>第 {page} 页</span> : null}
          </div>
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
              docId={type === "pdf" ? citation.doc_id : undefined}
              cacheKey={citation.doc_id}
              mimeType={state.mimeType}
              fileName={state.fileName}
              initialPage={page}
              highlightText={searchText}
              anchorBox={anchorBox ?? undefined}
            />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
