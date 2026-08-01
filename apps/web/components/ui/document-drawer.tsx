"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { getFilePreviewUrl, type AdminDocumentDetail } from "@/lib/api";
import { IconButton } from "./icon-button";

export function DocumentDrawer({
  detail,
  loading,
  onClose,
}: {
  detail?: AdminDocumentDetail;
  loading?: boolean;
  onClose: () => void;
}) {
  const doc = detail?.document;

  return (
    <div className="dm-drawer-overlay" onClick={onClose}>
      <aside className="dm-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="dm-drawer-head">
          <div className="dm-drawer-head-row">
            <h2>{doc?.file_name ?? "文档详情"}</h2>
            <IconButton onClick={onClose} aria-label="关闭">
              <X size={18} />
            </IconButton>
          </div>
        </div>

        <div className="dm-drawer-body">
          {loading ? <div className="dm-empty-state">加载中...</div> : null}
          {!loading && detail ? (
            <OriginalDocumentPreview
              docId={detail.document.doc_id}
              fileName={detail.document.file_name}
            />
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function OriginalDocumentPreview({ docId, fileName }: { docId: string; fileName: string }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getFilePreviewUrl(docId)
      .then((preview) => {
        if (!cancelled) setUrl(preview.preview_url);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "原文加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  if (error) return <div className="dm-document-error">{error}</div>;
  if (!url) return <div className="dm-document-loading">正在打开原文…</div>;
  return <iframe className="dm-admin-original-preview" src={url} title={`${fileName} 原文预览`} />;
}

export function statusLabel(
  status: string
): "已完成" | "解析中" | "待重建" | "失败" | "OCR中" | "已排除" {
  if (status === "parsed" || status === "indexed" || status === "cleaned" || status === "chunked") {
    return "已完成";
  }
  if (status === "parse_failed") return "失败";
  if (status === "ocr_pending") return "OCR中";
  if (status === "excluded_from_search") return "已排除";
  if (status === "parse_low_confidence") return "待重建";
  return "解析中";
}

export function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  const label = statusLabel(status);
  if (label === "已完成") return "success";
  if (label === "失败") return "danger";
  if (label === "待重建") return "neutral";
  return "warning";
}

export function formatSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
