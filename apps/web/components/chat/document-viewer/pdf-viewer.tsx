"use client";

import { adminDocumentPagePdfUrl } from "@/lib/api";
import { getAuthHeaders } from "@/lib/auth";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

interface PdfViewerProps {
  docId: string;
  cacheKey?: string;
  initialPage?: number | null;
  highlightText?: string;
  anchorBox?: { x0: number; y0: number; x1: number; y1: number; unit?: string; rotation?: number };
  fileName?: string;
  onReady?: () => void;
}

const pdfCache = new Map<string, Promise<PDFDocumentProxy>>();
const pageBlobCache = new Map<string, Promise<{ blob: Blob; totalPages?: number }>>();
const objectUrlCache = new Map<string, string>();

async function getCachedPageBlob(
  docId: string,
  pageNumber: number
): Promise<{ blob: Blob; totalPages?: number }> {
  const key = `${docId}:page:${pageNumber}`;
  const cached = pageBlobCache.get(key);
  if (cached) return cached;

  const promise = (async () => {
    const response = await fetch(adminDocumentPagePdfUrl(docId, pageNumber), {
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      throw new Error(`page ${pageNumber} fetch failed: ${response.status}`);
    }
    const totalHeader = response.headers.get("X-Total-Pages");
    const blob = await response.blob();
    return {
      blob,
      totalPages: totalHeader ? Number(totalHeader) : undefined,
    };
  })();

  pageBlobCache.set(key, promise);
  promise.catch(() => pageBlobCache.delete(key));
  return promise;
}

async function getCachedObjectUrl(docId: string, pageNumber: number, blob: Blob): Promise<string> {
  const key = `${docId}:page:${pageNumber}`;
  const cached = objectUrlCache.get(key);
  if (cached) return cached;

  const url = URL.createObjectURL(blob);
  objectUrlCache.set(key, url);
  return url;
}

async function getCachedPdf(sourceKey: string, url: string): Promise<PDFDocumentProxy> {
  const cached = pdfCache.get(sourceKey);
  if (cached) return cached;

  const promise = (async () => {
    const pdfjs = await import("pdfjs-dist");
    const publicBasePath = process.env.NEXT_PUBLIC_API_BASE ?? "";
    pdfjs.GlobalWorkerOptions.workerSrc = `${publicBasePath}/vendor/pdf.worker.mjs`;
    const loadingTask: any = pdfjs.getDocument(url);
    return loadingTask.promise;
  })();

  pdfCache.set(sourceKey, promise);
  promise.catch(() => pdfCache.delete(sourceKey));
  return promise;
}

export function PdfViewer({
  docId,
  cacheKey,
  initialPage,
  highlightText,
  anchorBox,
  onReady,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [loadedPages, setLoadedPages] = useState<number[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>("");

  // 先加载目标页拿到总页数，再展开默认范围
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const target = Math.max(1, initialPage ?? 1);
        const { blob, totalPages: totalHeader } = await getCachedPageBlob(docId, target);

        const url = await getCachedObjectUrl(docId, target, blob);
        const sourceKey = `${cacheKey ?? docId}:page:${target}`;
        const pdf = await getCachedPdf(sourceKey, url);
        if (cancelled) return;

        const pageCount = totalHeader && totalHeader > 0 ? totalHeader : pdf.numPages;
        setTotalPages(pageCount);

        const range: number[] = [];
        for (let p = target - 3; p <= target + 3; p += 1) {
          if (p >= 1 && p <= pageCount) range.push(p);
        }
        setLoadedPages(range);
        onReady?.();
      } catch (error) {
        console.error(`[PdfViewer] bootstrap error:`, error);
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : "PDF 加载失败");
        }
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [docId, cacheKey, initialPage, onReady]);

  // 滚动懒加载：只加载进入可视区域的 skeleton 及其相邻 1 页
  useEffect(() => {
    const container = containerRef.current;
    if (!container || totalPages === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const pageAttr = (entry.target as HTMLElement).dataset.page;
          if (!pageAttr) return;
          const page = Number(pageAttr);
          setLoadedPages((prev) => {
            if (prev.includes(page)) return prev;
            const next = new Set(prev);
            for (let p = page - 1; p <= page + 1; p += 1) {
              if (p >= 1 && p <= totalPages) next.add(p);
            }
            return Array.from(next).sort((a, b) => a - b);
          });
        });
      },
      { root: container, rootMargin: "0px", threshold: 0 }
    );

    container.querySelectorAll<HTMLElement>(".dm-pdf-page-skeleton").forEach((el) => {
      observer.observe(el);
    });

    return () => observer.disconnect();
  }, [totalPages, loadedPages]);

  const allPages = useMemo(() => {
    const pages: number[] = [];
    for (let p = 1; p <= totalPages; p += 1) {
      pages.push(p);
    }
    return pages;
  }, [totalPages]);

  const targetScrolledRef = useRef(false);

  return (
    <div ref={containerRef} className="dm-pdf-viewer">
      {errorMessage && <div className="dm-document-error">{errorMessage}</div>}
      {totalPages === 0 && !errorMessage && (
        <div className="dm-document-loading">正在打开原文…</div>
      )}
      {allPages.map((pageNumber) => {
        const isLoaded = loadedPages.includes(pageNumber);
        const isTarget = pageNumber === (initialPage ?? 1);
        return (
          <div
            key={pageNumber}
            data-page={pageNumber}
            className={`dm-pdf-page-wrapper ${isLoaded ? "is-loaded" : "dm-pdf-page-skeleton"}`}
          >
            {isLoaded ? (
              <SinglePdfPage
                docId={docId}
                cacheKey={cacheKey}
                pageNumber={pageNumber}
                totalPages={totalPages}
                isTarget={isTarget}
                highlightText={isTarget ? highlightText : undefined}
                anchorBox={isTarget ? anchorBox : undefined}
                onRender={
                  isTarget
                    ? () => {
                        if (targetScrolledRef.current) return;
                        targetScrolledRef.current = true;
                        const container = containerRef.current;
                        const target = container?.querySelector<HTMLElement>(
                          `.dm-pdf-page-wrapper[data-page="${initialPage ?? 1}"]`
                        );
                        if (container && target) {
                          container.scrollTo({
                            top: target.offsetTop - container.offsetTop,
                            behavior: "smooth",
                          });
                        }
                      }
                    : undefined
                }
              />
            ) : (
              <div className="dm-pdf-skeleton">
                <span>第 {pageNumber} / {totalPages} 页</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface SinglePdfPageProps {
  docId: string;
  cacheKey?: string;
  pageNumber: number;
  totalPages: number;
  isTarget: boolean;
  highlightText?: string;
  anchorBox?: { x0: number; y0: number; x1: number; y1: number; unit?: string; rotation?: number };
  onRender?: () => void;
}

interface PageSize {
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
  scale: number;
}

function SinglePdfPage({
  docId,
  cacheKey,
  pageNumber,
  totalPages,
  isTarget,
  highlightText,
  anchorBox,
  onRender,
}: SinglePdfPageProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<PDFPageProxy | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [size, setSize] = useState<PageSize | null>(null);

  // 加载单页 PDF 并计算 canvas 尺寸
  useEffect(() => {
    let cancelled = false;

    async function prepare() {
      try {
        const { blob } = await getCachedPageBlob(docId, pageNumber);
        const url = await getCachedObjectUrl(docId, pageNumber, blob);
        const sourceKey = `${cacheKey ?? docId}:page:${pageNumber}`;
        const pdf = await getCachedPdf(sourceKey, url);
        if (cancelled) return;

        const page = await pdf.getPage(1);
        if (cancelled) {
          page.cleanup();
          return;
        }
        pageRef.current = page;

        const wrapper = wrapperRef.current;
        const containerWidth = wrapper?.clientWidth || 620;
        const baseViewport = page.getViewport({ scale: 1 });
        const horizontalPadding = 32;
        const scale = Math.min(
          1.5,
          Math.max(0.5, (containerWidth - horizontalPadding) / baseViewport.width)
        );
        const viewport = page.getViewport({ scale });
        const dpr = window.devicePixelRatio || 1;

        setSize({
          width: Math.floor(viewport.width * dpr),
          height: Math.floor(viewport.height * dpr),
          cssWidth: Math.floor(viewport.width),
          cssHeight: Math.floor(viewport.height),
          scale,
        });
        setStatus("ready");
        onRender?.();
      } catch (error) {
        console.error(`[SinglePdfPage] page ${pageNumber} error:`, error);
        if (!cancelled) {
          setStatus("error");
        }
      }
    }

    prepare();
    return () => {
      cancelled = true;
      pageRef.current?.cleanup();
      pageRef.current = null;
    };
  }, [docId, cacheKey, pageNumber]);

  // canvas 尺寸确定后绘制页面与可选文本层
  useEffect(() => {
    if (!size || !canvasRef.current || !pageRef.current) return;
    const canvas = canvasRef.current;
    const page = pageRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.scale(dpr, dpr);

    const viewport = page.getViewport({ scale: size.scale });
    const task = page.render({ canvasContext: ctx, viewport });

    let textLayerTask: { cancel: () => void } | undefined;
    (async () => {
      try {
        const textLayerDiv = textLayerRef.current;
        if (!textLayerDiv) return;
        textLayerDiv.innerHTML = "";
        const pdfjs = await import("pdfjs-dist");
        const textLayer = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textLayerDiv,
          viewport,
        });
        textLayerTask = textLayer;
        await textLayer.render();
        if (highlightText && isTarget) {
          highlightInElement(textLayerDiv, highlightText);
        }
        renderAnchorBoxOverlay(overlayRef.current, anchorBox, size, isTarget);
      } catch {
        // text layer 是可选能力，失败不影响阅读
      }
    })();

    return () => {
      task.cancel?.();
      textLayerTask?.cancel();
    };
  }, [size, highlightText, anchorBox, isTarget]);

  return (
    <div
      ref={wrapperRef}
      className={`dm-pdf-single-page ${isTarget ? "is-target" : ""} ${
        status === "ready" ? "is-ready" : ""
      }`}
    >
      {status === "loading" && (
        <div className="dm-pdf-skeleton">
          <span>第 {pageNumber} / {totalPages} 页</span>
        </div>
      )}
      {status === "error" && (
        <div className="dm-pdf-skeleton dm-pdf-skeleton-error">第 {pageNumber} 页加载失败</div>
      )}
      {status === "ready" && size && (
        <div className="dm-pdf-page">
          <canvas
            ref={canvasRef}
            width={size.width}
            height={size.height}
            style={{ width: size.cssWidth, height: size.cssHeight }}
          />
          <div
            ref={textLayerRef}
            className="dm-pdf-text-layer"
            style={{ width: size.cssWidth, height: size.cssHeight }}
          />
          <div
            ref={overlayRef}
            className="dm-pdf-anchor-overlay"
            style={{ width: size.cssWidth, height: size.cssHeight }}
          />
        </div>
      )}
    </div>
  );
}

function highlightInElement(root: HTMLElement, text: string) {
  const terms = text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
  if (terms.length === 0) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  for (const textNode of textNodes) {
    const parent = textNode.parentElement;
    if (!parent) continue;
    const nodeText = textNode.textContent || "";
    const lowerNodeText = nodeText.toLowerCase();
    const term = terms.find((t) => lowerNodeText.includes(t.toLowerCase()));
    if (!term) continue;

    const index = lowerNodeText.indexOf(term.toLowerCase());
    const before = nodeText.slice(0, index);
    const match = nodeText.slice(index, index + term.length);
    const after = nodeText.slice(index + term.length);

    const highlight = document.createElement("span");
    highlight.className = "dm-citation-highlight";
    highlight.textContent = match;

    parent.insertBefore(document.createTextNode(before), textNode);
    parent.insertBefore(highlight, textNode);
    parent.insertBefore(document.createTextNode(after), textNode);
    parent.removeChild(textNode);
  }
}

function renderAnchorBoxOverlay(
  overlay: HTMLDivElement | null,
  anchorBox: SinglePdfPageProps["anchorBox"],
  size: PageSize | null,
  isTarget: boolean
) {
  if (!overlay || !anchorBox || !size || !isTarget) {
    if (overlay) overlay.innerHTML = "";
    return;
  }
  overlay.innerHTML = "";
  const rotation = anchorBox.rotation ?? 0;
  const effectiveRotation = ((rotation % 360) + 360) % 360;
  let left = anchorBox.x0 * size.cssWidth;
  let top = anchorBox.y0 * size.cssHeight;
  let width = (anchorBox.x1 - anchorBox.x0) * size.cssWidth;
  let height = (anchorBox.y1 - anchorBox.y0) * size.cssHeight;

  // PDF 用户坐标原点在左下角；渲染容器原点在左上角，因此垂直翻转。
  top = size.cssHeight - top - height;

  // 处理 90/180/270 简单旋转：交换宽高并重新映射左上角。
  if (effectiveRotation === 90 || effectiveRotation === 270) {
    const tmp = width;
    width = height;
    height = tmp;
  }
  if (effectiveRotation === 90) {
    left = anchorBox.y0 * size.cssWidth;
    top = (1.0 - anchorBox.x1) * size.cssHeight;
  } else if (effectiveRotation === 180) {
    left = (1.0 - anchorBox.x1) * size.cssWidth;
    top = anchorBox.y0 * size.cssHeight;
  } else if (effectiveRotation === 270) {
    left = (1.0 - anchorBox.y1) * size.cssWidth;
    top = anchorBox.x0 * size.cssHeight;
  }

  if (width <= 0 || height <= 0) return;

  const box = document.createElement("div");
  box.className = "dm-anchor-box";
  box.style.left = `${Math.max(0, left)}px`;
  box.style.top = `${Math.max(0, top)}px`;
  box.style.width = `${Math.min(width, size.cssWidth - left)}px`;
  box.style.height = `${Math.min(height, size.cssHeight - top)}px`;
  overlay.appendChild(box);
}
