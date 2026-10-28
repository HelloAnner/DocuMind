"use client";

import { GlobalWorkerOptions, getDocument, TextLayer } from "pdfjs-dist";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
} from "pdfjs-dist";
import { ChevronLeft, ChevronRight, Minus, Plus, RefreshCw, Scan } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { filePreviewContentUrl } from "@/lib/api";
import { getAuthHeaders } from "@/lib/auth";

interface PdfViewerProps {
  docId: string;
  conversationId?: string;
  initialPage?: number | null;
  anchorBox?: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    unit?: string;
    rotation?: number;
  };
  fileName?: string;
  onReady?: () => void;
}

type ViewerStatus = "loading" | "ready" | "error";

export function PdfViewer({
  docId,
  conversationId,
  initialPage,
  anchorBox,
  fileName,
  onReady,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const onReadyRef = useRef(onReady);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [status, setStatus] = useState<ViewerStatus>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [slow, setSlow] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [pageNumber, setPageNumber] = useState(Math.max(1, initialPage ?? 1));
  const [totalPages, setTotalPages] = useState(0);
  const [fitWidth, setFitWidth] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let timedOut = false;
    setPdf(null);
    setStatus("loading");
    setErrorMessage("");
    setSlow(false);
    setTotalPages(0);

    const slowTimer = window.setTimeout(() => setSlow(true), 5_000);
    const timeoutTimer = window.setTimeout(() => {
      timedOut = true;
      void loadingTask?.destroy();
      if (!cancelled) {
        setStatus("error");
        setErrorMessage("原文加载超时，请重试或下载原文查看。");
      }
    }, 15_000);

    void (async () => {
      try {
        const publicBasePath = process.env.NEXT_PUBLIC_API_BASE ?? "";
        GlobalWorkerOptions.workerSrc = `${publicBasePath}/vendor/pdf.worker.mjs`;
        loadingTask = getDocument({
          url: filePreviewContentUrl(docId, conversationId),
          httpHeaders: getAuthHeaders(),
          rangeChunkSize: 128 * 1024,
        });
        const document = await loadingTask.promise;
        if (cancelled || timedOut) {
          await document.destroy();
          return;
        }
        const target = Math.min(Math.max(1, initialPage ?? 1), document.numPages);
        setPdf(document);
        setTotalPages(document.numPages);
        setPageNumber(target);
        setStatus("ready");
      } catch (error) {
        if (!cancelled && !timedOut) {
          setStatus("error");
          setErrorMessage(error instanceof Error ? error.message : "PDF 加载失败");
        }
      } finally {
        window.clearTimeout(slowTimer);
        window.clearTimeout(timeoutTimer);
        if (!cancelled) setSlow(false);
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(slowTimer);
      window.clearTimeout(timeoutTimer);
      void loadingTask?.destroy();
    };
  }, [conversationId, docId, reloadKey]);

  useEffect(() => {
    if (!pdf) return;
    setPageNumber(Math.min(Math.max(1, initialPage ?? 1), pdf.numPages));
  }, [initialPage, pdf]);

  useEffect(() => {
    if (!pdf || !canvasRef.current || !containerRef.current || containerWidth === 0) return;
    let cancelled = false;
    let page: PDFPageProxy | null = null;
    let renderTask: RenderTask | null = null;
    let textLayerTask: TextLayer | null = null;

    void (async () => {
      try {
        page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(280, containerWidth - 32);
        const scale = fitWidth
          ? Math.min(2, Math.max(0.35, availableWidth / baseViewport.width))
          : zoom;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const textLayerNode = textLayerRef.current;
        const overlay = overlayRef.current;
        if (!canvas || !textLayerNode || !overlay) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        textLayerNode.style.width = `${viewport.width}px`;
        textLayerNode.style.height = `${viewport.height}px`;
        overlay.style.width = `${viewport.width}px`;
        overlay.style.height = `${viewport.height}px`;
        textLayerNode.innerHTML = "";
        overlay.innerHTML = "";

        const context = canvas.getContext("2d");
        if (!context) throw new Error("浏览器无法创建 PDF 画布");
        renderTask = page.render({
          canvasContext: context,
          viewport,
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        });
        await renderTask.promise;
        if (cancelled) return;

        textLayerTask = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textLayerNode,
          viewport,
        });
        await textLayerTask.render();
        if (cancelled) return;
        renderAnchorBox(overlay, anchorBox, page, viewport, pageNumber === (initialPage ?? 1));
        onReadyRef.current?.();
      } catch (error) {
        if (!cancelled && (!(error instanceof Error) || error.name !== "RenderingCancelledException")) {
          setStatus("error");
          setErrorMessage(error instanceof Error ? error.message : "PDF 页面渲染失败");
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayerTask?.cancel();
      page?.cleanup();
    };
  }, [anchorBox, containerWidth, fitWidth, initialPage, pageNumber, pdf, zoom]);

  const changePage = (next: number) => {
    if (totalPages === 0) return;
    setPageNumber(Math.min(Math.max(1, next), totalPages));
  };

  return (
    <div className="dm-pdf-viewer-shell" aria-label={fileName ? `${fileName} PDF 预览` : "PDF 预览"}>
      <div className="dm-pdf-toolbar">
        <div className="dm-pdf-page-controls">
          <button
            aria-label="上一页"
            disabled={pageNumber <= 1 || status !== "ready"}
            onClick={() => changePage(pageNumber - 1)}
            type="button"
          >
            <ChevronLeft size={16} />
          </button>
          <label>
            <span className="sr-only">页码</span>
            <input
              aria-label="页码"
              disabled={status !== "ready"}
              max={Math.max(1, totalPages)}
              min={1}
              onChange={(event) => changePage(Number(event.target.value))}
              type="number"
              value={pageNumber}
            />
          </label>
          <span>/ {totalPages || "—"}</span>
          <button
            aria-label="下一页"
            disabled={pageNumber >= totalPages || status !== "ready"}
            onClick={() => changePage(pageNumber + 1)}
            type="button"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="dm-pdf-zoom-controls">
          <button
            aria-label="缩小"
            disabled={status !== "ready" || (!fitWidth && zoom <= 0.5)}
            onClick={() => {
              setFitWidth(false);
              setZoom((value) => Math.max(0.5, value - 0.15));
            }}
            type="button"
          >
            <Minus size={15} />
          </button>
          <button
            aria-label="适合宽度"
            className={fitWidth ? "is-active" : ""}
            disabled={status !== "ready"}
            onClick={() => setFitWidth(true)}
            type="button"
          >
            <Scan size={15} />
            <span>适宽</span>
          </button>
          <button
            aria-label="放大"
            disabled={status !== "ready" || (!fitWidth && zoom >= 2.5)}
            onClick={() => {
              setFitWidth(false);
              setZoom((value) => Math.min(2.5, value + 0.15));
            }}
            type="button"
          >
            <Plus size={15} />
          </button>
        </div>
      </div>

      <div ref={containerRef} className="dm-pdf-viewer">
        {status === "loading" ? (
          <div className="dm-document-loading" role="status">
            <span>正在打开原文…</span>
            {slow ? <small>文件较大，仍在加载</small> : null}
          </div>
        ) : null}
        {status === "error" ? (
          <div className="dm-document-error" role="alert">
            <strong>PDF 预览失败</strong>
            <span>{errorMessage}</span>
            <button onClick={() => setReloadKey((value) => value + 1)} type="button">
              <RefreshCw size={15} />
              重试
            </button>
          </div>
        ) : null}
        {status === "ready" ? (
          <div className="dm-pdf-page" data-page={pageNumber}>
            <canvas ref={canvasRef} />
            <div ref={textLayerRef} className="dm-pdf-text-layer" />
            <div ref={overlayRef} className="dm-pdf-anchor-overlay" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function renderAnchorBox(
  overlay: HTMLDivElement,
  anchorBox: PdfViewerProps["anchorBox"],
  page: PDFPageProxy,
  viewport: PageViewport,
  isTarget: boolean
) {
  overlay.innerHTML = "";
  if (!anchorBox || !isTarget) return;

  const [xMin, yMin, xMax, yMax] = page.view;
  const source = [
    xMin + anchorBox.x0 * (xMax - xMin),
    yMin + anchorBox.y0 * (yMax - yMin),
    xMin + anchorBox.x1 * (xMax - xMin),
    yMin + anchorBox.y1 * (yMax - yMin),
  ];
  const [leftA, topA, leftB, topB] = viewport.convertToViewportRectangle(source);
  const left = Math.max(0, Math.min(leftA, leftB));
  const top = Math.max(0, Math.min(topA, topB));
  const width = Math.min(viewport.width - left, Math.abs(leftB - leftA));
  const height = Math.min(viewport.height - top, Math.abs(topB - topA));
  if (width <= 0 || height <= 0) return;

  const box = document.createElement("div");
  box.className = "dm-anchor-box";
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;
  overlay.appendChild(box);
}
