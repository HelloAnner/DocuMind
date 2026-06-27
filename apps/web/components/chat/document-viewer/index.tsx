"use client";

import { Download, FileWarning } from "lucide-react";
import { PdfViewer } from "./pdf-viewer";
import { ImageViewer } from "./image-viewer";
import { TextViewer } from "./text-viewer";

export interface DocumentViewerProps {
  blobUrl: string;
  mimeType: string;
  fileName?: string;
  initialPage?: number | null;
  highlightText?: string;
  docId?: string;
  cacheKey?: string;
  onReady?: () => void;
}

export function DocumentViewer({
  blobUrl,
  mimeType,
  fileName,
  initialPage,
  highlightText,
  docId,
  cacheKey,
  onReady,
}: DocumentViewerProps) {
  if (mimeType === "application/pdf" && docId) {
    return (
      <PdfViewer
        docId={docId}
        cacheKey={cacheKey}
        initialPage={initialPage}
        highlightText={highlightText}
        fileName={fileName}
        onReady={onReady}
      />
    );
  }

  if (mimeType.startsWith("image/")) {
    return <ImageViewer blobUrl={blobUrl} fileName={fileName} />;
  }

  if (mimeType.startsWith("text/") || mimeType === "application/markdown") {
    return <TextViewer blobUrl={blobUrl} highlightText={highlightText} />;
  }

  return <UnsupportedViewer blobUrl={blobUrl} fileName={fileName} />;
}

function UnsupportedViewer({ blobUrl, fileName }: { blobUrl: string; fileName?: string }) {
  return (
    <div className="dm-document-unsupported">
      <FileWarning size={40} />
      <p>该文件类型暂不支持在线预览</p>
      <a
        href={blobUrl}
        download={fileName || "原文文件"}
        className="dm-document-download"
      >
        <Download size={16} />
        下载原文查看
      </a>
    </div>
  );
}
