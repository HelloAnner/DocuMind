"use client";

import { useState } from "react";

interface ImageViewerProps {
  blobUrl: string;
  fileName?: string;
}

export function ImageViewer({ blobUrl, fileName }: ImageViewerProps) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="dm-image-viewer">
      {!loaded && <div className="dm-document-loading">正在打开原文…</div>}
      <img
        src={blobUrl}
        alt={fileName || "图片原文"}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
      />
    </div>
  );
}
