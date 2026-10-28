"use client";

import { X } from "lucide-react";
import { DocumentPreview } from "@/components/chat/document-preview";
import type { AdminDocumentDetail } from "@/lib/api";
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
            <div className="dm-admin-original-preview">
              <DocumentPreview
                target={{
                  doc_id: detail.document.doc_id,
                  doc_title: detail.document.file_name,
                  file_type: detail.document.file_type,
                }}
              />
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
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
