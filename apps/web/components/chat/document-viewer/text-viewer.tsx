"use client";

import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";

interface TextViewerProps {
  blobUrl: string;
  charRange?: { start: number; end: number };
}

export function TextViewer({ blobUrl, charRange }: TextViewerProps) {
  const highlightRef = useRef<HTMLSpanElement | null>(null);
  const [text, setText] = useState<string>("");
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(blobUrl)
      .then((response) => {
        if (!response.ok) throw new Error("加载失败");
        return response.text();
      })
      .then((value) => {
        if (!cancelled) setText(value);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [blobUrl]);

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [text, charRange?.start, charRange?.end]);

  if (error) return <div className="dm-document-error">文本加载失败</div>;

  return (
    <pre className="dm-text-viewer">
      {charRange ? renderCharRange(text, charRange, highlightRef) : text}
    </pre>
  );
}

function renderCharRange(
  text: string,
  charRange: { start: number; end: number },
  highlightRef: MutableRefObject<HTMLSpanElement | null>
) {
  const chars = Array.from(text);
  const start = Math.max(0, Math.min(charRange.start, chars.length));
  const end = Math.max(start, Math.min(charRange.end, chars.length));
  if (start === end) return text;

  return (
    <>
      {chars.slice(0, start).join("")}
      <span ref={highlightRef} className="dm-citation-highlight">
        {chars.slice(start, end).join("")}
      </span>
      {chars.slice(end).join("")}
    </>
  );
}
