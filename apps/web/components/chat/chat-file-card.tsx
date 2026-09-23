"use client";

import { useState } from "react";
import { Download, FileText } from "lucide-react";
import { apiErrorMessage, downloadChatFile } from "@/lib/api";
import type { ChatFile } from "@/lib/types";

export function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fileExtLabel(file: Pick<ChatFile, "name" | "mime_type">) {
  const fromName = file.name.includes(".")
    ? file.name.slice(file.name.lastIndexOf(".") + 1)
    : "";
  const normalized = fromName.trim().toUpperCase();
  if (normalized && normalized.length <= 6) return normalized;
  const subtype = file.mime_type?.split("/")[1]?.split("+")[0]?.split(";")[0] ?? "";
  const fromMime = subtype.trim().toUpperCase();
  return fromMime && fromMime.length <= 6 ? fromMime : "文件";
}

/** 后端 UserFileSource 只有 upload / sandbox（sandbox = 助手在沙箱里产出或改写）。 */
export function fileSourceLabel(source: string) {
  if (source === "upload") return "用户上传";
  if (source === "sandbox") return "助手产物";
  return source ? source : "文件";
}

export function ChatFileCard({
  file,
  badge,
}: {
  file: Pick<ChatFile, "id" | "name" | "mime_type" | "size_bytes" | "source">;
  badge?: string;
}) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setError("");
    try {
      await downloadChatFile(file);
    } catch (downloadError) {
      setError(apiErrorMessage(downloadError, "下载失败"));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <span className="dm-file-card-wrap" role="listitem">
      <button
        aria-label={`下载文件 ${file.name}`}
        className="dm-file-card"
        disabled={downloading}
        onClick={() => void handleDownload()}
        type="button"
      >
        <span className="dm-conversation-file-icon" aria-hidden="true">
          <FileText size={18} />
          <small>{fileExtLabel(file)}</small>
        </span>
        <span className="dm-file-card-copy">
          <strong title={file.name}>{file.name}</strong>
          <span className="dm-file-card-meta">
            {badge ?? fileSourceLabel(file.source)}
            {file.size_bytes > 0 ? ` · ${formatFileSize(file.size_bytes)}` : ""}
          </span>
        </span>
        <Download size={15} aria-hidden="true" className="dm-file-card-action" />
      </button>
      {error ? (
        <span className="dm-feedback-error is-inline" role="alert">{error}</span>
      ) : null}
    </span>
  );
}
