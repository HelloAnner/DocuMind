"use client";

import { TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";

export interface AnchorBox {
  x0: number; y0: number; x1: number; y1: number; unit?: string; rotation?: number;
}

export function PdfPage({ pdf, number, near, scale, width, height, availableWidth, anchorBox, onReady }: {
  pdf: PDFDocumentProxy; number: number; near: boolean; scale: number;
  width: number; height: number; availableWidth?: number; anchorBox?: AnchorBox; onReady?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<PDFPageProxy | null>(null);
  const viewportRef = useRef<PageViewport | null>(null);
  const readyRef = useRef(onReady);
  const [size, setSize] = useState({ width, height });
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [rendered, setRendered] = useState(false);
  scale = availableWidth === undefined ? scale : Math.min(1, availableWidth / size.width);
  readyRef.current = onReady;

  useEffect(() => {
    if (!near) return;
    let cancelled = false, task: RenderTask | undefined, textTask: TextLayer | undefined;
    let page: PDFPageProxy | undefined;
    const canvas = canvasRef.current, text = textRef.current;
    setError(""); setRendered(false);
    const work = (async () => {
      try {
        page = await pdf.getPage(number);
        if (cancelled || !canvas || !text) return;
        const native = page.getViewport({ scale: 1 });
        setSize({ width: native.width, height: native.height });
        const viewport = page.getViewport({ scale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
        canvas.width = Math.ceil(viewport.width * dpr); canvas.height = Math.ceil(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("浏览器无法创建 PDF 画布");
        task = page.render({ canvasContext: context, viewport, transform: [dpr, 0, 0, dpr, 0, 0] });
        await task.promise;
        if (cancelled) return;
        text.style.setProperty("--scale-factor", String(scale));
        textTask = new TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
        await textTask.render();
        if (cancelled) return;
        pageRef.current = page; viewportRef.current = viewport;
        setRendered(true);
      } catch (error) {
        if (!cancelled && (!(error instanceof Error) || error.name !== "RenderingCancelledException")) setError(error instanceof Error ? error.message : "页面渲染失败");
      } finally {
        if (cancelled) { if (canvas) canvas.width = canvas.height = 0; page?.cleanup(); }
      }
    })();
    return () => {
      cancelled = true; task?.cancel(); textTask?.cancel();
      pageRef.current = null; viewportRef.current = null;
      void work.finally(() => { if (canvas) canvas.width = canvas.height = 0; page?.cleanup(); });
    };
  }, [near, number, pdf, retry, scale]);

  useEffect(() => {
    const overlay = overlayRef.current, page = pageRef.current, viewport = viewportRef.current;
    if (!overlay) return;
    overlay.replaceChildren();
    if (page && viewport && rendered) {
      if (anchorBox) renderAnchorBox(overlay, anchorBox, page, viewport);
      readyRef.current?.();
    }
  }, [anchorBox, rendered, scale, near]);

  return (
    <section className="dm-pdf-page" data-page={number} aria-label={`第 ${number} 页`}
      style={{ width: size.width * scale, height: size.height * scale }}>
      {!near || !rendered ? <span className="dm-pdf-page-placeholder" aria-hidden="true">第 {number} 页</span> : null}
      {near ? <>
        <canvas key={`${scale}-${retry}`} ref={canvasRef} role="img" aria-label={`第 ${number} 页原文`} />
        <div key={`text-${scale}-${retry}`} ref={textRef} className="dm-pdf-text-layer" style={{ width: size.width * scale, height: size.height * scale }} />
        <div ref={overlayRef} className="dm-pdf-anchor-overlay" style={{ width: size.width * scale, height: size.height * scale }} />
      </> : null}
      {error ? <div className="dm-document-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRetry(value => value + 1)}>重试此页</button></div> : null}
    </section>
  );
}

function renderAnchorBox(overlay: HTMLDivElement, box: AnchorBox, page: PDFPageProxy, viewport: PageViewport) {
  const [xMin, yMin, xMax, yMax] = page.view;
  const source = [xMin + box.x0 * (xMax - xMin), yMin + box.y0 * (yMax - yMin), xMin + box.x1 * (xMax - xMin), yMin + box.y1 * (yMax - yMin)];
  const [leftA, topA, leftB, topB] = viewport.convertToViewportRectangle(source);
  const left = Math.max(0, Math.min(leftA, leftB)), top = Math.max(0, Math.min(topA, topB));
  const width = Math.min(viewport.width - left, Math.abs(leftB - leftA)), height = Math.min(viewport.height - top, Math.abs(topB - topA));
  if (width <= 0 || height <= 0) return;
  const highlight = document.createElement("div");
  highlight.className = "dm-anchor-box";
  Object.assign(highlight.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  overlay.append(highlight);
}
