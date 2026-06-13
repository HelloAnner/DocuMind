"use client";

import { FolderOpen } from "lucide-react";
import { Badge } from "./badge";

export function KnowledgeCard({
  name,
  desc,
  docs,
  chunks,
}: {
  name: string;
  desc: string;
  docs: number;
  chunks: number;
}) {
  return (
    <div className="dm-knowledge-card">
      <div className="dm-knowledge-card-head">
        <FolderOpen size={20} />
        <Badge tone="success">已完成</Badge>
      </div>
      <strong>{name}</strong>
      <p>{desc}</p>
      <div className="dm-knowledge-card-stats">
        <span>{docs} 文档</span>
        <span>{chunks.toLocaleString()} 切片</span>
      </div>
    </div>
  );
}
