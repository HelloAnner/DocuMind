"use client";

import { FolderOpen } from "lucide-react";
import { clsx } from "clsx";
import type { ReactNode } from "react";
import { Badge } from "./badge";

export function KnowledgeCard({
  name,
  desc,
  docs,
  chunks,
  status = "active",
  active,
  onClick,
  action,
}: {
  name: string;
  desc: string;
  docs: number;
  chunks: number;
  status?: string;
  active?: boolean;
  onClick?: () => void;
  action?: ReactNode;
}) {
  const label = status === "disabled" ? "停用" : status === "archived" ? "归档" : "启用";
  const tone = status === "active" ? "success" : status === "disabled" ? "warning" : "neutral";
  return (
    <div
      className={clsx("dm-knowledge-card", active && "active", onClick && "clickable")}
      onClick={onClick}
      onKeyDown={(event) => {
        if (onClick && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onClick();
        }
      }}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div className="dm-knowledge-card-head">
        <FolderOpen size={20} />
        <Badge tone={tone}>{label}</Badge>
      </div>
      <strong>{name}</strong>
      <p>{desc}</p>
      <div className="dm-knowledge-card-stats">
        <span>{docs} 文档</span>
        <span>{chunks.toLocaleString()} 切片</span>
      </div>
      {action ? <div className="dm-knowledge-card-actions">{action}</div> : null}
    </div>
  );
}
