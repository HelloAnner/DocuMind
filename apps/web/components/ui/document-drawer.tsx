"use client";

import { RefreshCw, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { AdminDocumentDetail } from "@/lib/api";
import { Badge } from "./badge";
import { Button } from "./button";
import { IconButton } from "./icon-button";

const tabs = ["文档信息", "原文预览", "切片列表", "表格", "解析块"];

export function DocumentDrawer({
  detail,
  loading,
  onClose,
  onRetry,
  actions,
}: {
  detail?: AdminDocumentDetail;
  loading?: boolean;
  onClose: () => void;
  onRetry?: () => void;
  actions?: ReactNode;
}) {
  const [activeTab, setActiveTab] = useState(1);
  const doc = detail?.document;
  const job = detail?.latest_job;

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
          <div className="dm-drawer-meta">
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {doc ? `${doc.file_type.toUpperCase()} · ${formatSize(doc.file_size)} · ${doc.chunk_count} 切片` : "加载中"}
            </span>
            {doc ? <Badge tone={statusTone(doc.parse_status)}>{statusLabel(doc.parse_status)}</Badge> : null}
          </div>
        </div>

        <div className="dm-drawer-tabs">
          {tabs.map((tab, index) => (
            <button
              key={tab}
              className={activeTab === index ? "active" : ""}
              onClick={() => setActiveTab(index)}
              type="button"
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="dm-drawer-body">
          {loading ? <div className="dm-empty-state">加载中...</div> : null}
          {!loading && detail && activeTab === 1 ? (
            <div className="dm-original-preview">
              <div className="dm-original-preview-head">
                <strong>{detail.preview.title || detail.document.title}</strong>
                <span>
                  {detail.preview.mode === "parsed_text"
                    ? `${detail.preview.char_count.toLocaleString()} 字符`
                    : detail.preview.mode === "failed"
                    ? "解析失败"
                    : "等待解析"}
                </span>
              </div>
              {detail.preview.text ? (
                <pre>{detail.preview.text}</pre>
              ) : (
                <div className="dm-empty-state">
                  {detail.preview.mode === "failed" ? "解析失败，暂无可展示原文。" : "文档解析完成后展示原文预览。"}
                </div>
              )}
              {detail.preview.truncated ? (
                <div className="dm-preview-note">当前仅展示前 60,000 字符，完整内容仍保留在原始文件和解析结果中。</div>
              ) : null}
            </div>
          ) : null}

          {!loading && detail && activeTab === 0 ? (
            <div className="dm-doc-inspector">
              <div>
                <span>知识库</span>
                <strong>{detail.document.kb_name}</strong>
              </div>
              <div>
                <span>解析版本</span>
                <strong>v{detail.document.parse_version}</strong>
              </div>
              <div>
                <span>质量分</span>
                <strong>{job?.quality_score == null ? "—" : `${Math.round(job.quality_score * 100)}%`}</strong>
              </div>
              <div>
                <span>块 / 表格 / 字符</span>
                <strong>
                  {job?.block_count ?? 0} / {job?.table_count ?? 0} / {job?.char_count ?? 0}
                </strong>
              </div>
              <div>
                <span>文件 SHA-256</span>
                <code>{detail.document.file_sha256}</code>
              </div>
              {job?.error_message ? (
                <div className="danger">
                  <span>{job.error_code ?? "parse_error"}</span>
                  <strong>{job.error_message}</strong>
                </div>
              ) : null}
              {job?.warnings ? (
                <div>
                  <span>Warnings</span>
                  <code>{JSON.stringify(job.warnings)}</code>
                </div>
              ) : null}
              {onRetry ? (
                <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={onRetry}>
                  重试解析
                </Button>
              ) : null}
              {actions ? <div className="dm-drawer-action-stack">{actions}</div> : null}
            </div>
          ) : null}

          {!loading && detail && activeTab === 4
            ? detail.blocks.map((block) => (
                <div className="dm-chunk-row" key={block.block_id}>
                  <span>
                    #{block.block_index + 1} · {block.block_type}
                    {block.page_start ? ` · 第 ${block.page_start} 页` : ""}
                    {block.slide_index ? ` · Slide ${block.slide_index}` : ""}
                  </span>
                  <strong>{block.heading_path.length ? block.heading_path.join(" / ") : "Root"}</strong>
                  <p>{block.text}</p>
                </div>
              ))
            : null}

          {!loading && detail && activeTab === 2
            ? detail.chunks.map((chunk) => (
                <div className="dm-chunk-row" key={chunk.chunk_id}>
                  <span>
                    切片 #{chunk.chunk_index + 1} · {chunk.source_type} · {chunk.token_count} tokens
                  </span>
                  <strong>{chunk.heading_path.length ? chunk.heading_path.join(" / ") : "Root"}</strong>
                  <p>{chunk.content}</p>
                </div>
              ))
            : null}

          {!loading && detail && activeTab === 3
            ? detail.tables.map((table) => (
                <div className="dm-table-preview" key={table.table_id}>
                  <span>
                    表格 #{table.table_index + 1} · {table.row_count} x {table.col_count}
                  </span>
                  <strong>{table.title ?? "未命名表格"}</strong>
                  <pre>{table.markdown}</pre>
                </div>
              ))
            : null}
        </div>
      </aside>
    </div>
  );
}

export function statusLabel(status: string): "已完成" | "解析中" | "待重建" | "失败" {
  if (status === "parsed" || status === "indexed" || status === "cleaned" || status === "chunked") {
    return "已完成";
  }
  if (status === "parse_failed") return "失败";
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
