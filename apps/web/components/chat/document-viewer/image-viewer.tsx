"use client";

import { useState } from "react";

interface ImageViewerProps {
  blobUrl: string;
  fileName?: string;
}

export function ImageViewer({ blobUrl, fileName }: ImageViewerProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

  return (
    <div className="dm-image-viewer">
      {status === "loading" ? <div className="dm-document-loading">正在打开原文…</div> : null}
      {status === "failed" ? (
        <div className="dm-document-error" role="alert">图片原文加载失败</div>
      ) : null}
      <img
        hidden={status === "failed"}
        src={blobUrl}
        alt={fileName || "图片原文"}
        onLoad={() => setStatus("ready")}
        onError={() => setStatus("failed")}
      />
    </div>
  );
}
