"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { Citation } from "@/lib/types";

interface AnswerContentProps {
  content: string;
  citations: Citation[];
  onCitationClick?: (index: number) => void;
}

function CitationBadge({ index, onClick }: { index: number; onClick?: () => void }) {
  return (
    <button type="button" className="dm-citation-badge" onClick={onClick}>
      [{index}]
    </button>
  );
}

function InlineText({ text, onCitationClick }: { text: string; onCitationClick?: (index: number) => void }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(/^\[(\d+)\]$/);
        if (match) {
          const idx = Number(match[1]);
          return <CitationBadge key={i} index={idx} onClick={() => onCitationClick?.(idx)} />;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="dm-code-block">
      <div className="dm-code-block-head">
        <span>{lang || "code"}</span>
        <button type="button" onClick={handleCopy} aria-label="复制">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function MarkdownTable({ lines }: { lines: string[] }) {
  const rows = lines
    .filter((l) => l.trim().startsWith("|") && l.trim().endsWith("|"))
    .map((l) =>
      l
        .trim()
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim())
    );
  if (rows.length < 2) return null;
  const [header, ...body] = rows;
  const separator = body[0]?.every((c) => /^[-:]+$/.test(c));
  const dataRows = separator ? body.slice(1) : body;
  return (
    <table className="dm-answer-table">
      <thead>
        <tr>
          {header.map((h, i) => (
            <th key={i}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {dataRows.map((row, ri) => (
          <tr key={ri}>
            {row.map((cell, ci) => (
              <td key={ci}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function parseBlocks(content: string) {
  const lines = content.split("\n");
  const blocks: Array<
    | { type: "paragraph"; text: string }
    | { type: "code"; lang?: string; code: string }
    | { type: "table"; lines: string[] }
    | { type: "list"; items: string[]; ordered: boolean }
  > = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      const fence = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", lang: fence || undefined, code: codeLines.join("\n") });
      i++;
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const tableLines: string[] = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim().startsWith("|") &&
        lines[i].trim().endsWith("|")
      ) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "table", lines: tableLines });
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+/);
    const ordered = trimmed.match(/^\d+\.\s+/);
    if (unordered || ordered) {
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i].trim();
        if (l.match(/^[-*]\s+/) || l.match(/^\d+\.\s+/)) {
          items.push(l.replace(/^([-*]|\d+\.)\s+/, ""));
          i++;
        } else if (l === "" && items.length > 0) {
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: "list", items, ordered: !!ordered });
      continue;
    }

    if (trimmed !== "") {
      const paraLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== "" && !lines[i].trim().startsWith("```") && !lines[i].trim().startsWith("|")) {
        paraLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "paragraph", text: paraLines.join(" ").trim() });
      continue;
    }

    i++;
  }

  return blocks;
}

export function AnswerContent({ content, onCitationClick }: AnswerContentProps) {
  const blocks = parseBlocks(content);
  return (
    <div className="dm-answer-content">
      {blocks.map((block, idx) => {
        if (block.type === "paragraph") {
          return (
            <p key={idx}>
              <InlineText text={block.text} onCitationClick={onCitationClick} />
            </p>
          );
        }
        if (block.type === "code") {
          return <CodeBlock key={idx} code={block.code} lang={block.lang} />;
        }
        if (block.type === "table") {
          return <MarkdownTable key={idx} lines={block.lines} />;
        }
        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag key={idx} className="dm-answer-list">
              {block.items.map((item, i) => (
                <li key={i}>
                  <InlineText text={item} onCitationClick={onCitationClick} />
                </li>
              ))}
            </ListTag>
          );
        }
        return null;
      })}
    </div>
  );
}
