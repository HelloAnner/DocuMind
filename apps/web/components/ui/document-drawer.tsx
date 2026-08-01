"use client";

import { X } from "lucide-react";
import { useState } from "react";
import { DocumentPreview } from "@/components/chat/document-preview";
import type { AdminDocumentDetail } from "@/lib/api";
import { IconButton } from "./icon-button";

const tabs = [
  { value: "preview", label: "原文预览" },
  { value: "cleaned", label: "清洗块" },
] as const;
type DrawerTab = (typeof tabs)[number]["value"];

export function DocumentDrawer({
  detail,
  loading,
  onClose,
}: {
  detail?: AdminDocumentDetail;
  loading?: boolean;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<DrawerTab>("preview");
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

        <div className="dm-drawer-tabs" role="tablist" aria-label="文档视图">
          {tabs.map((tab) => (
            <button
              aria-selected={activeTab === tab.value}
              key={tab.value}
              className={activeTab === tab.value ? "active" : ""}
              onClick={() => setActiveTab(tab.value)}
              role="tab"
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className={`dm-drawer-body${activeTab === "preview" ? " is-preview" : ""}`}>
          {loading ? <div className="dm-empty-state">加载中...</div> : null}
          {!loading && detail && activeTab === "preview" ? (
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

          {!loading && detail && activeTab === "cleaned" ? (
            detail.cleaned_blocks.length ? (
              detail.cleaned_blocks.map((block) => (
                <div className="dm-chunk-row" key={block.block_id}>
                  <span>
                    清洗块 #{block.block_index + 1} · {block.block_type}
                    {block.is_removed ? ` · 已移除：${block.remove_reason ?? "noise"}` : ""}
                  </span>
                  <strong>{block.heading_path.length ? block.heading_path.join(" / ") : "Root"}</strong>
                  <small>{block.cleaning_ops.length ? block.cleaning_ops.join(" / ") : "未执行清洗操作"}</small>
                  <p>{block.cleaned_text}</p>
                </div>
              ))
            ) : (
              <div className="dm-empty-state">暂无清洗块</div>
            )
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
