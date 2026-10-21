"use client";

import { useEffect, useState } from "react";
import { Download, FileText, RefreshCw } from "lucide-react";
import {
  apiErrorMessage,
  downloadChatFile,
  fetchFileDownloadBlob,
} from "@/lib/api";
import type { ChatFile } from "@/lib/types";
import { fileExtLabel, formatFileSize } from "./chat-file-card";
import {
  filePreviewKind,
  isTextPreviewWithinLimit,
} from "./file-preview-utils";

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; kind: "image" | "pdf"; blobUrl: string; byteLength: number }
  | { status: "text"; text: string; byteLength: number }
  | { status: "text-too-large"; byteLength: number }
  | { status: "download-only"; byteLength: number }
  | { status: "failed"; error: string };

function byteLengthOf(file: ChatFile) {
  return Number.isFinite(file.size_bytes) && file.size_bytes > 0 ? file.size_bytes : 0;
}

/**
 * 抽屉内的文件预览：图片/PDF 使用鉴权下载得到的 Blob URL，
 * 文本只渲染转义后的 <pre>，其余格式只提供下载。
 */
export function ChatFileInlinePreview({ file }: { file: ChatFile }) {
  const kind = filePreviewKind(file);
  const [state, setState] = useState<PreviewState>(() =>
    kind === "download"
      ? { status: "download-only", byteLength: byteLengthOf(file) }
      : { status: "loading" }
  );
  const [retryToken, setRetryToken] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  useEffect(() => {
    const currentKind = filePreviewKind(file);
    let cancelled = false;
    let objectUrl: string | null = null;

    setDownloadError("");
    if (currentKind === "download") {
      setState({ status: "download-only", byteLength: byteLengthOf(file) });
      return;
    }

    setState({ status: "loading" });
    fetchFileDownloadBlob(file.id)
      .then(async (blob) => {
        if (cancelled) return;
        if (currentKind === "image" || currentKind === "pdf") {
          // 不采用响应 Blob 的任意 MIME，尤其不能把伪装 PDF 的 HTML 放进 iframe。
          const rawMime = file.mime_type.split(";")[0].trim().toLowerCase();
          const fallbackType = currentKind === "pdf" ? "application/pdf"
            : /^image\/(png|jpeg|gif|webp|avif)$/.test(rawMime) ? rawMime : "application/octet-stream";
          const typed = new Blob([blob], { type: fallbackType });
          objectUrl = URL.createObjectURL(typed);
          setState({
            status: "ready",
            kind: currentKind,
            blobUrl: objectUrl,
            byteLength: blob.size,
          });
          return;
        }
        if (!isTextPreviewWithinLimit(blob.size)) {
          setState({ status: "text-too-large", byteLength: blob.size });
          return;
        }
        const text = await blob.text();
        if (!cancelled) setState({ status: "text", text, byteLength: blob.size });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: "failed", error: apiErrorMessage(error, "文件加载失败") });
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id, file.mime_type, file.name, file.size_bytes, retryToken]);

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError("");
    try {
      await downloadChatFile(file);
    } catch (error) {
      setDownloadError(apiErrorMessage(error, "下载失败"));
    } finally {
      setDownloading(false);
    }
  };

  const meta = `${fileExtLabel(file)}${state.status === "text-too-large" || state.status === "download-only" || state.status === "text" || state.status === "ready"
    ? ` · ${formatFileSize(state.byteLength)}`
    : ""}`;

  const downloadFooter = (
    <div className="dm-file-preview-footer">
      <span>{meta}</span>
      <button disabled={downloading} onClick={() => void download()} type="button">
        <Download size={14} aria-hidden="true" />
        {downloading ? "下载中…" : "下载"}
      </button>
    </div>
  );

  return (
    <div className="dm-file-inline-preview" data-testid="chat-file-inline-preview">
      {state.status === "loading" ? (
        <div className="dm-file-preview-message" role="status">
          <span>正在打开文件…</span>
        </div>
      ) : null}

      {state.status === "failed" ? (
        <div className="dm-file-preview-message" role="alert">
          <strong>无法打开文件</strong>
          <span>{state.error}</span>
          <div className="dm-file-preview-message-actions">
            <button onClick={() => setRetryToken((value) => value + 1)} type="button">
              <RefreshCw size={14} aria-hidden="true" />
              重试
            </button>
            <button disabled={downloading} onClick={() => void download()} type="button">
              <Download size={14} aria-hidden="true" />
              下载
            </button>
          </div>
        </div>
      ) : null}

      {state.status === "download-only" || state.status === "text-too-large" ? (
        <div className="dm-file-preview-message">
          <FileText size={30} aria-hidden="true" />
          <strong>{file.name}</strong>
          <span>
            {state.status === "text-too-large"
              ? "文本超过 200 KB，在线预览已省略，请下载后查看。"
              : "该格式暂不支持在线预览，请下载后查看。"}
          </span>
          {downloadFooter}
        </div>
      ) : null}

      {state.status === "text" ? (
        <>
          <pre
            aria-label={`${file.name} 文本预览`}
            className="dm-file-preview-text"
            tabIndex={0}
          >
            {state.text}
          </pre>
          {downloadFooter}
        </>
      ) : null}

      {state.status === "ready" && state.kind === "image" ? (
        <>
          <div className="dm-file-preview-image-wrap">
            {/* Blob URL 来自带鉴权头的 fetch，浏览器不会再次暴露原始地址。 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt={file.name} src={state.blobUrl} />
          </div>
          {downloadFooter}
        </>
      ) : null}

      {state.status === "ready" && state.kind === "pdf" ? (
        <>
          <iframe
            className="dm-file-preview-frame"
            sandbox=""
            src={state.blobUrl}
            title={`${file.name} PDF 预览`}
          />
          {downloadFooter}
        </>
      ) : null}

      {downloadError ? (
        <span className="dm-file-preview-download-error" role="alert">
          {downloadError}
        </span>
      ) : null}
    </div>
  );
}
