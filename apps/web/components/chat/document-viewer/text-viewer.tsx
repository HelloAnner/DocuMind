"use client";

import { useEffect, useState } from "react";

interface TextViewerProps {
  blobUrl: string;
  highlightText?: string;
}

export function TextViewer({ blobUrl, highlightText }: TextViewerProps) {
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

  if (error) return <div className="dm-document-error">文本加载失败</div>;

  return (
    <pre className="dm-text-viewer">
      {highlightText ? renderHighlightedText(text, highlightText) : text}
    </pre>
  );
}

function renderHighlightedText(text: string, highlightText: string) {
  const terms = highlightText
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
  if (terms.length === 0) return text;

  const pattern = new RegExp(`(${terms.map(escapeRegex).join("|")})`, "gi");
  const parts = text.split(pattern);

  return parts.map((part, index) =>
    terms.some((t) => part.toLowerCase() === t.toLowerCase()) ? (
      <span key={index} className="dm-citation-highlight">
        {part}
      </span>
    ) : (
      part
    )
  );
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
