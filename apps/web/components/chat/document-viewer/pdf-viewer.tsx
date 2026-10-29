"use client";

import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { Minus, Plus, RefreshCw, Scan } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { filePreviewContentUrl } from "@/lib/api";
import { getAuthHeaders } from "@/lib/auth";
import { PdfPage, type AnchorBox } from "./pdf-page";

interface PdfViewerProps {
  docId?: string;
  blobUrl?: string;
  conversationId?: string;
  initialPage?: number | null;
  anchorBox?: AnchorBox;
  fileName?: string;
  onReady?: () => void;
}

export function PdfViewer({ docId, blobUrl, conversationId, initialPage, anchorBox, fileName, onReady }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  const location = useRef({ page: Math.max(1, initialPage ?? 1), offset: 0 });
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [size, setSize] = useState({ width: 595, height: 842 });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [slow, setSlow] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [pageNumber, setPageNumber] = useState(location.current.page);
  const [zoom, setZoom] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [nearby, setNearby] = useState<Set<number>>(new Set());
  const totalPages = pdf?.numPages ?? 0;
  const availableWidth = Math.max(1, containerWidth - 32);
  const scale = zoom ?? Math.min(1, availableWidth / size.width);
  onReadyRef.current = onReady;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setContainerWidth(entry.contentRect.width); });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false, timedOut = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    setPdf(null); setStatus("loading"); setErrorMessage(""); setSlow(false); setNearby(new Set()); setZoom(null);
    const slowTimer = window.setTimeout(() => setSlow(true), 5_000);
    const timeoutTimer = window.setTimeout(() => {
      timedOut = true;
      void loadingTask?.destroy().catch(() => {});
      if (!cancelled) { setStatus("error"); setErrorMessage("原文加载超时，请重试或下载原文查看。"); }
    }, 15_000);
    void (async () => {
      try {
        if (!docId && !blobUrl) throw new Error("缺少 PDF 预览地址");
        GlobalWorkerOptions.workerSrc = `${process.env.NEXT_PUBLIC_API_BASE ?? ""}/vendor/pdf.worker.mjs`;
        loadingTask = getDocument({
          url: docId ? filePreviewContentUrl(docId, conversationId) : blobUrl!,
          httpHeaders: docId ? getAuthHeaders() : undefined,
          rangeChunkSize: 128 * 1024, disableAutoFetch: true, disableStream: true, isEvalSupported: false,
        });
        const document = await loadingTask.promise;
        const first = await document.getPage(1);
        if (cancelled || timedOut) return;
        const viewport = first.getViewport({ scale: 1 });
        setSize({ width: viewport.width, height: viewport.height });
        location.current = { page: Math.min(Math.max(1, initialPage ?? 1), document.numPages), offset: 0 };
        setPageNumber(location.current.page); setPdf(document); setStatus("ready");
      } catch (error) {
        if (!cancelled && !timedOut) { setStatus("error"); setErrorMessage(error instanceof Error ? error.message : "PDF 加载失败"); }
      } finally {
        window.clearTimeout(slowTimer); window.clearTimeout(timeoutTimer);
        if (!cancelled) setSlow(false);
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(slowTimer); window.clearTimeout(timeoutTimer);
      void loadingTask?.destroy().catch(() => {});
    };
    // A citation update scrolls the existing document; it must not fetch it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, docId, blobUrl, reloadKey]);

  const jumpTo = (next: number, offset = 0) => {
    if (!pdf || !Number.isFinite(next)) return;
    const page = Math.min(Math.max(1, Math.trunc(next)), pdf.numPages);
    const element = pagesRef.current?.children[page - 1] as HTMLElement | undefined;
    if (containerRef.current && element) containerRef.current.scrollTop = element.offsetTop - 16 + offset * element.offsetHeight;
    location.current = { page, offset }; setPageNumber(page);
  };
  useLayoutEffect(() => {
    if (pdf) jumpTo(initialPage ?? 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPage, pdf]);
  useLayoutEffect(() => {
    if (pdf) jumpTo(location.current.page, location.current.offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, pdf]);

  useEffect(() => {
    const container = containerRef.current, pages = pagesRef.current;
    if (!pdf || !container || !pages) return;
    const observer = new IntersectionObserver(entries => {
      setNearby(previous => {
        const next = new Set(previous);
        for (const entry of entries) {
          const number = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) next.add(number); else next.delete(number);
        }
        return next;
      });
    }, { root: container, rootMargin: "100% 0px" });
    for (const page of Array.from(pages.children)) observer.observe(page);
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        let low = 0, high = pages.children.length - 1;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if ((pages.children[mid] as HTMLElement).offsetTop <= container.scrollTop + 40) low = mid; else high = mid - 1;
        }
        const element = pages.children[low] as HTMLElement;
        location.current = { page: low + 1, offset: Math.max(0, (container.scrollTop - element.offsetTop + 16) / element.offsetHeight) };
        setPageNumber(low + 1);
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => { observer.disconnect(); container.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); };
  }, [pdf]);

  return (
    <div className="dm-pdf-viewer-shell" aria-label={fileName ? `${fileName} PDF 预览` : "PDF 预览"}>
      <div className="dm-pdf-toolbar">
        <div className="dm-pdf-page-controls">
          <input aria-label="页码" disabled={status !== "ready"} max={Math.max(1, totalPages)} min={1}
            onChange={event => jumpTo(Number(event.target.value))} type="number" value={pageNumber} />
          <span>/ {totalPages || "—"}</span><span className="dm-pdf-scroll-hint">上下滚动</span>
        </div>
        <div className="dm-pdf-zoom-controls">
          <button aria-label="缩小" disabled={status !== "ready" || scale <= .25} onClick={() => setZoom(Math.max(.25, scale - .15))} type="button"><Minus size={15} /></button>
          <span>{Math.round(scale * 100)}%</span>
          <button aria-label="放大" disabled={status !== "ready" || scale >= 3} onClick={() => setZoom(Math.min(3, scale + .15))} type="button"><Plus size={15} /></button>
          <button aria-label="舒适阅读" title="舒适阅读：适应宽度，不放大原文" className={zoom === null ? "is-active" : ""}
            disabled={status !== "ready"} onClick={() => setZoom(null)} type="button"><Scan size={15} /></button>
        </div>
      </div>
      <div ref={containerRef} className="dm-pdf-viewer" tabIndex={0} aria-label="文档连续滚动阅读区">
        {status === "loading" ? <div className="dm-document-loading" role="status"><span>正在打开原文…</span>{slow ? <small>文件较大，仍在加载</small> : null}</div> : null}
        {status === "error" ? <div className="dm-document-error" role="alert"><strong>PDF 预览失败</strong><span>{errorMessage}</span>
          <button onClick={() => setReloadKey(value => value + 1)} type="button"><RefreshCw size={15} />重试</button></div> : null}
        {status === "ready" && pdf ? <div ref={pagesRef} className="dm-pdf-pages">
          {Array.from({ length: totalPages }, (_, index) => <PdfPage key={index + 1} pdf={pdf} number={index + 1}
            near={nearby.has(index + 1)} width={size.width} height={size.height} scale={zoom ?? 1}
            availableWidth={zoom === null ? availableWidth : undefined}
            anchorBox={index + 1 === (initialPage ?? 1) ? anchorBox : undefined}
            onReady={index + 1 === (initialPage ?? 1) ? () => onReadyRef.current?.() : undefined} />)}
        </div> : null}
      </div>
    </div>
  );
}
