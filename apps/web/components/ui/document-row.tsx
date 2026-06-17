"use client";

import { FileText } from "lucide-react";
import { Badge } from "./badge";

export type DocumentStatus = "已完成" | "解析中" | "待重建" | "失败";

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
  onClick?: () => void;
}) {
  const tone =
    status === "已完成"
      ? "success"
      : status === "解析中"
      ? "warning"
      : status === "待重建"
      ? "neutral"
      : "danger";

  return (
    <button className="dm-document-row" onClick={onClick} type="button">
      <span className="dm-document-name">
        <FileText size={18} />
        <span>
          <strong>{name}</strong>
          {kbName ? <small>{kbName}</small> : null}
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
    </button>
  );
}
