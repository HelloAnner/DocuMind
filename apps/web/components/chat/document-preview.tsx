"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fallbackPlugin,
  imagePlugin,
  officePlugin,
  textPlugin,
} from "@open-file-viewer/core";
import type { PreviewFile, PreviewPlugin } from "@open-file-viewer/core";
import { FileViewer } from "@open-file-viewer/react";
import { fetchAdminDocumentOriginalBlob } from "@/lib/api";
import type { Citation } from "@/lib/types";

interface DocumentPreviewProps {
  citation: Citation;
}

type BlobState =
  | { status: "idle" | "loading"; url?: undefined; error?: undefined }
  | { status: "ready"; blob: Blob; error?: undefined }
  | { status: "failed"; url?: undefined; error: string };

const publicBasePath = process.env.NEXT_PUBLIC_API_BASE ?? "";
const pdfWorkerSrc = `${publicBasePath}/vendor/pdf.worker.mjs`;
const pdfCMapUrl = `${publicBasePath}/vendor/cmaps/`;
const pdfStandardFontDataUrl = `${publicBasePath}/vendor/standard_fonts/`;
const pdfOptions = {
  useFetchData: true,
  workerSrc: pdfWorkerSrc,
  cMapUrl: pdfCMapUrl,
  cMapPacked: true,
  standardFontDataUrl: pdfStandardFontDataUrl,
};

const basePreviewPlugins = [officePlugin({ pdf: pdfOptions }), fallbackPlugin()];

function createPdfObjectUrl(file: PreviewFile) {
  if (file.url) return { url: file.url, revoke: false };
  if (!file.blob) return null;
  return { url: URL.createObjectURL(file.blob), revoke: true };
}

function pdfFragment(page: number | null, searchText: string) {
  const params = new URLSearchParams();
  if (page && page > 0) params.set("page", String(page));
  params.set("zoom", "page-width");
  if (searchText) params.set("search", searchText);
  const fragment = params.toString();
  return fragment ? `#${fragment}` : "";
}

function browserPdfPlugin(page: number | null, searchText: string): PreviewPlugin {
  return {
    name: "browser-pdf",
    match(file) {
      return file.mimeType === "application/pdf" || file.extension === "pdf";
    },
    render(ctx) {
      const objectUrl = createPdfObjectUrl(ctx.file);
      if (!objectUrl) {
        throw new Error("PDF 原文文件不可用");
      }
      const frame = document.createElement("iframe");
      frame.className = "dm-native-pdf-viewer";
      frame.title = ctx.file.name || "PDF 原文预览";
      frame.src = `${objectUrl.url}${pdfFragment(page, searchText)}`;
      ctx.viewport.replaceChildren(frame);
      return {
        destroy() {
          frame.remove();
          if (objectUrl.revoke) URL.revokeObjectURL(objectUrl.url);
        },
      };
    },
  };
}

function fileType(citation: Citation) {
  const explicit = citation.anchor?.format;
  if (explicit) return explicit.toLowerCase();
  const title = citation.doc_title.toLowerCase();
  if (title.endsWith(".pdf")) return "pdf";
  if (title.endsWith(".pptx") || title.endsWith(".ppt")) return "pptx";
  if (title.endsWith(".docx") || title.endsWith(".doc")) return "docx";
  if (title.endsWith(".md")) return "md";
  return "txt";
}

function viewerMime(type: string, blob: Blob) {
  if (type === "pdf") return "application/pdf";
  if (type === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (type === "pptx") {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  if (type === "md" || type === "txt") return "text/plain";
  return blob.type || "application/octet-stream";
}

function targetPage(citation: Citation) {
  return citation.anchor?.page ?? citation.page_range[0] ?? null;
}

function citationSearchText(citation: Citation) {
  const beforeFollowingContext = citation.quote.split("【下文】")[0] ?? citation.quote;
  const normalized = beforeFollowingContext
    .replace(/【上文】|【下文】/g, " ")
    .replace(/标题路径[:：][^。！？\n]*/g, " ")
    .replace(/页码[:：]\s*\d+/g, " ")
    .trim();

  const candidates = normalized
    .split(/[。！？；;|\n]+/)
    .map((segment) => segment.replace(/\s+/g, " ").trim())
    .filter((segment) => segment.length >= 6 && /[A-Za-z0-9\u4e00-\u9fff]/.test(segment));

  const chosen =
    candidates
      .slice()
      .reverse()
      .find((segment) => segment.length <= 90) ??
    candidates[candidates.length - 1] ??
    normalized.replace(/\s+/g, " ");
  const chars = Array.from(chosen);
  if (chars.length <= 80) return chosen;

  const words = chosen.split(/\s+/).filter(Boolean);
  const selected: string[] = [];
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const next = [words[index], ...selected].join(" ");
    if (Array.from(next).length > 80 && selected.length > 0) break;
    selected.unshift(words[index]);
  }
  const compact = selected.join(" ");
  return compact || chars.slice(-80).join("");
}

function applyCitationLocation(root: HTMLElement | null, page: number | null, searchText: string) {
  if (!root) return;

  if (page && page > 0) {
    const pageIndex = page - 1;
    const pageNode = root.querySelector<HTMLElement>(
      `.ofv-pdf-page-wrapper[data-page-index="${pageIndex}"]`
    );
    pageNode?.scrollIntoView({ block: "start", inline: "nearest" });
  }

  if (searchText) {
    const searchInput = root.querySelector<HTMLInputElement>('.ofv-toolbar-search input[type="search"]');
    if (searchInput && searchInput.value !== searchText) {
      searchInput.value = searchText;
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
}

export function DocumentPreview({ citation }: DocumentPreviewProps) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [blobState, setBlobState] = useState<BlobState>({ status: "idle" });
  const [loadTick, setLoadTick] = useState(0);
  const type = fileType(citation);
  const page = targetPage(citation);
  const searchText = useMemo(() => citationSearchText(citation), [citation]);
  const plugins = useMemo(
    () => [imagePlugin(), textPlugin(), browserPdfPlugin(page, searchText), ...basePreviewPlugins],
    [page, searchText]
  );
  const handleViewerLoad = useCallback(() => {
    setLoadTick((tick) => tick + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBlobState({ status: "loading" });
    setLoadTick(0);

    fetchAdminDocumentOriginalBlob(citation.doc_id)
      .then((blob) => {
        if (cancelled) return;
        setBlobState({
          status: "ready",
          blob: new Blob([blob], { type: viewerMime(type, blob) }),
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBlobState({
            status: "failed",
            error: error instanceof Error ? error.message : "原文文件加载失败",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [citation.doc_id, type]);

  useEffect(() => {
    if (blobState.status !== "ready" || loadTick === 0) return;

    const timers: number[] = [];
    [0, 120, 360, 800, 1400, 2200].forEach((delay) => {
      timers.push(
        window.setTimeout(() => {
          applyCitationLocation(previewRef.current, page, searchText);
        }, delay)
      );
    });

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [blobState.status, loadTick, page, searchText]);

  return (
    <div ref={previewRef} className="dm-original-document-preview">
      {blobState.status === "loading" ? (
        <div className="dm-file-view-overlay">正在打开原文...</div>
      ) : null}

      {blobState.status === "failed" ? (
        <div className="dm-file-view-error">原始文件暂不可预览。</div>
      ) : null}

      {blobState.status === "ready" ? (
        <FileViewer
          key={`${citation.doc_id}-${citation.chunk_id}-${page ?? "start"}-${searchText}`}
          className="dm-file-viewer"
          file={blobState.blob}
          fileName={citation.doc_title}
          mimeType={blobState.blob.type}
          width="100%"
          height="100%"
          fit="width"
          toolbar={{
            zoom: true,
            rotate: true,
            download: true,
            fullscreen: false,
            print: true,
            search: true,
          }}
          theme="dark"
          plugins={plugins}
          onLoad={handleViewerLoad}
        />
      ) : null}
    </div>
  );
}
