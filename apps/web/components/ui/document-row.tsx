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
      className="dm-document-row"
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
      <span className="dm-document-name">
        <FileText size={18} />
        <span>
          <strong>{name}</strong>
          {kbName ? <small>{kbName}</small> : null}
          {meta ? <small>{meta}</small> : null}
        </span>
      </span>
      <span className="dm-document-cell">{type}</span>
      <span className="dm-document-cell">{size}</span>
      <span className="dm-document-cell">{pages ?? "—"}</span>
      <span className="dm-document-cell">{status === "失败" ? "—" : chunks}</span>
      <span className="dm-document-cell">{tables ?? 0}</span>
      <span className="dm-document-cell">{quality == null ? "—" : `${Math.round(quality * 100)}%`}</span>
      <span className="dm-document-cell">
        <Badge tone={tone}>{status}</Badge>
      </span>
      <span className="dm-document-cell">{updated}</span>
      {actions ? (
        <span className="dm-document-actions" onClick={(event) => event.stopPropagation()}>
          {actions}
        </span>
      ) : null}
    </div>
  );
}
