"use client";

import { useEffect, useState } from "react";
import { getAdminDocument, type AdminDocumentDetail, type DocumentChunk } from "@/lib/api";
import type { Citation } from "@/lib/types";

interface DocumentPreviewProps {
  citation: Citation;
}

export function DocumentPreview({ citation }: DocumentPreviewProps) {
  const [detail, setDetail] = useState<AdminDocumentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    getAdminDocument(citation.doc_id)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "加载文档失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [citation.doc_id]);

  let chunk: DocumentChunk | undefined;
  if (detail) {
    chunk = detail.chunks.find((c) => c.chunk_id === citation.chunk_id);
    if (!chunk) {
      chunk = detail.chunks.find(
        (c) =>
          c.page_start != null &&
          citation.page_range.length > 0 &&
          c.page_start <= citation.page_range[0] &&
          (c.page_end ?? c.page_start) >= citation.page_range[0]
      );
    }
  }

  const content = chunk?.content ?? citation.quote;
  const page = chunk?.page_start ?? citation.page_range[0] ?? "-";

  return (
    <div className="dm-doc-preview">
      <div className="dm-doc-preview-head">
        <span className="dm-doc-preview-title">{citation.doc_title}</span>
        <span className="dm-doc-preview-page">第 {page} 页</span>
      </div>
      <div className="dm-doc-preview-highlight">
        <p>{content}</p>
      </div>
      {loading && <p className="dm-doc-preview-hint">正在加载完整文档…</p>}
      {error && (
        <p className="dm-doc-preview-hint">
          {error}，当前显示引用片段。
        </p>
      )}
      {!loading && !error && chunk && (
        <p className="dm-doc-preview-hint">已自动定位到引用片段</p>
      )}
    </div>
  );
}
