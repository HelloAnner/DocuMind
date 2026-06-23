"use client";

import { FileText, Presentation, File } from "lucide-react";
import type { Citation } from "@/lib/types";

interface CitationCardProps {
  citation: Citation;
  onClick?: (c: Citation) => void;
  active?: boolean;
}

export function isCitationDeleted(citation: Citation) {
  return citation.source_status === "deleted";
}

function docIcon(title: string) {
  const lower = title.toLowerCase();
  if (lower.endsWith(".pptx") || lower.endsWith(".ppt")) return Presentation;
  if (lower.endsWith(".pdf")) return File;
  return FileText;
}

export function CitationCard({ citation, onClick, active }: CitationCardProps) {
  const deleted = isCitationDeleted(citation);
  const Icon = docIcon(citation.doc_title);
  return (
    <button
      type="button"
      className={`dm-citation-card ${active ? "active" : ""}`}
      onClick={() => onClick?.(citation)}
    >
      <div className="dm-citation-card-head">
        <span className="dm-citation-card-meta">
          <Icon size={13} />
          <span className="dm-citation-card-doc">{citation.doc_title}</span>
          {citation.page_range.length > 0 && (
            <span className="dm-citation-card-page">
              · 第 {citation.page_range.join("-")} 页
            </span>
          )}
        </span>
        <span className="dm-citation-card-index">[{citation.index}]</span>
      </div>
      <p>{citation.quote}</p>
      {deleted ? <span className="dm-deleted-source-badge">原文已删除</span> : null}
    </button>
  );
}
