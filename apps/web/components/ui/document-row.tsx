"use client";

import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "./badge";

export type DocumentStatus =
  | "已完成"
  | "解析中"
  | "待重建"
  | "失败"
  | "低置信"
  | "OCR中"
  | "已排除"
  | "未知";

export function DocumentRow({
  name,
  type,
  size,
  pages,
  chunks,
  tables,
  quality,
  kbName,
  status,
  updated,
  meta,
  actions,
  onClick,
  selected,
  onSelect,
}: {
  name: string;
  type: string;
  size?: string;
  pages?: number;
  chunks: number;
  tables?: number;
  quality?: number;
  kbName?: string;
  status: DocumentStatus;
  updated: string;
  meta?: string;
  actions?: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
}) {
  const tone =
    status === "已完成"
      ? "success"
      : status === "解析中" || status === "低置信" || status === "OCR中"
      ? "warning"
      : status === "待重建" || status === "已排除"
      ? "neutral"
      : "danger";

  return (
    <div
      className={`dm-document-row${selected ? " is-selected" : ""}`}
      onClick={onClick}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && onClick) {
          event.preventDefault();
          onClick();
        }
      }}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {onSelect ? (
        <span className="dm-document-checkbox" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected ?? false}
            onChange={(event) => onSelect(event.target.checked)}
            aria-label={`选择 ${name}`}
          />
        </span>
      ) : null}
      <span className="dm-document-name">
        <FileText size={18} />
        <span>
          <strong>{name}</strong>
          {kbName ? <small>{kbName}</small> : null}
          {meta ? <small>{meta}</small> : null}
        </span>
      </span>
      <span className="dm-document-cell" data-label="类型">{type}</span>
      <span className="dm-document-cell" data-label="大小">{size}</span>
      <span className="dm-document-cell" data-label="页数">{pages ?? "—"}</span>
      <span className="dm-document-cell" data-label="切片">{status === "失败" ? "—" : chunks}</span>
      <span className="dm-document-cell" data-label="表格">{tables ?? 0}</span>
      <span className="dm-document-cell" data-label="质量">{quality == null ? "—" : `${Math.round(quality * 100)}%`}</span>
      <span className="dm-document-cell" data-label="状态">
        <Badge tone={tone}>{status}</Badge>
      </span>
      <span className="dm-document-cell" data-label="更新时间">{updated}</span>
      {actions ? (
        <span className="dm-document-actions" data-label="操作" onClick={(event) => event.stopPropagation()}>
          {actions}
        </span>
      ) : null}
    </div>
  );
}
