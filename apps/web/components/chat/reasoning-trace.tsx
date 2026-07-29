"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  FileSearch,
  Search,
  Wrench,
  XCircle,
} from "lucide-react";
import type { MessageStatus, RuntimeToolCall } from "@/lib/types";

interface ReasoningTraceProps {
  thinking?: string;
  toolCalls?: RuntimeToolCall[];
  isStreaming: boolean;
  durationMs?: number;
  status: MessageStatus;
}

export function ReasoningTrace({
  thinking,
  toolCalls,
  isStreaming,
  durationMs,
  status,
}: ReasoningTraceProps) {
  const [expanded, setExpanded] = useState(isStreaming);
  const [observedDurationMs, setObservedDurationMs] = useState(durationMs);
  const startedAtRef = useRef<number | null>(isStreaming ? Date.now() : null);
  const wasStreamingRef = useRef(isStreaming);
  const visibleTools = useMemo(() => toolCalls ?? [], [toolCalls]);
  const thinkingLines = useMemo(() => splitThinkingLines(thinking ?? ""), [thinking]);
  const hasRealToolCall = visibleTools.length > 0;

  useEffect(() => {
    if (isStreaming) {
      if (startedAtRef.current === null) {
        startedAtRef.current = Date.now();
      }
      setExpanded(true);
    } else if (wasStreamingRef.current) {
      const startedAt = startedAtRef.current;
      if (durationMs === undefined && startedAt !== null) {
        setObservedDurationMs(Math.max(1, Date.now() - startedAt));
      }
      startedAtRef.current = null;
      setExpanded(false);
    }
    wasStreamingRef.current = isStreaming;
  }, [durationMs, isStreaming]);

  useEffect(() => {
    if (durationMs !== undefined) {
      setObservedDurationMs(durationMs);
    }
  }, [durationMs]);

  if (!hasRealToolCall) return null;

  return (
    <section
      className={`dm-reasoning-trace ${expanded ? "expanded" : ""} ${isStreaming ? "running" : "completed"}`}
      data-testid="reasoning-trace"
    >
      {!isStreaming ? (
        <button
          aria-expanded={expanded}
          className="dm-reasoning-toggle dm-reasoning-summary"
          onClick={() => setExpanded((value) => !value)}
          title="展开或收起思维链"
          type="button"
        >
          <span>{completedLabel(status, observedDurationMs)}</span>
          <ChevronDown className="dm-reasoning-chevron" size={16} />
        </button>
      ) : null}

      {expanded ? (
        <div className="dm-reasoning-detail">
          <ActionFeed
            thinkingLines={thinkingLines}
            toolCalls={visibleTools}
            isStreaming={isStreaming}
          />
        </div>
      ) : null}
    </section>
  );
}

function ActionFeed({
  thinkingLines,
  toolCalls,
  isStreaming,
}: {
  thinkingLines: string[];
  toolCalls: RuntimeToolCall[];
  isStreaming: boolean;
}) {
  return (
    <div className="action-feed-panel">
      {thinkingLines.map((line, index) => (
        <ThinkingTimelineRow
          key={`thinking-${index}`}
          text={line}
          running={isStreaming && index === thinkingLines.length - 1}
        />
      ))}
      {toolCalls.map((tool) => (
        <ToolTimelineRow key={tool.id} tool={tool} />
      ))}
    </div>
  );
}

function ThinkingTimelineRow({ text, running }: { text: string; running: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const plainText = markdownToPlainText(text, expanded);
  const hasOverflow = Array.from(markdownToPlainText(text, false)).length > 96;
  const preview = expanded ? plainText : truncateThinking(plainText);

  return (
    <div className="action-feed-row action-feed-thinking-row">
      <TimelineIconSlot kind={running ? "loading" : "success"} />
      <span className="action-feed-row-text is-muted">
        {preview}
        {hasOverflow && !expanded ? (
          <button
            aria-label="展示完整思考内容"
            className="dm-thinking-more"
            onClick={() => setExpanded(true)}
            type="button"
          >
            更多
          </button>
        ) : null}
      </span>
    </div>
  );
}

function ToolTimelineRow({ tool }: { tool: RuntimeToolCall }) {
  const isRunning = tool.status === "running";
  const isFailed = tool.status === "failed" || tool.status === "cancelled";
  const duration =
    tool.duration_ms !== undefined && !isRunning ? formatDuration(tool.duration_ms) : null;

  return (
    <div className="action-feed-row">
      <TimelineIconSlot kind={timelineIconKind(tool, isRunning, isFailed)} />
      <span className={`action-feed-row-text ${isRunning ? "is-strong" : ""}`}>
        {formatToolAction(tool)}
      </span>
      {duration ? <span className="action-feed-duration">{duration}</span> : null}
    </div>
  );
}

type TimelineIconKind = "read" | "search" | "tool" | "success" | "warning" | "loading";

function TimelineIconSlot({ kind }: { kind: TimelineIconKind }) {
  return (
    <span className="action-feed-icon-slot" aria-hidden="true">
      <span className="action-feed-icon-line action-feed-icon-line-top" />
      <span className="action-feed-icon">
        {kind === "loading" ? (
          <span className="dm-action-spinner" />
        ) : kind === "success" ? (
          <CheckCircle2 size={15} />
        ) : kind === "warning" ? (
          <XCircle size={15} />
        ) : kind === "read" ? (
          <FileSearch size={15} />
        ) : kind === "search" ? (
          <Search size={15} />
        ) : kind === "tool" ? (
          <Wrench size={15} />
        ) : (
          <Circle size={15} />
        )}
      </span>
      <span className="action-feed-icon-line action-feed-icon-line-bottom" />
    </span>
  );
}

function splitThinkingLines(content: string) {
  return content
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function markdownToPlainText(markdown: string, preserveLineBreaks: boolean) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, (block) =>
      block.replace(/```[^\n]*\n?/g, "").replace(/```/g, " ")
    )
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1");

  return preserveLineBreaks
    ? text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim()
    : text.replace(/\s+/g, " ").trim();
}

function truncateThinking(text: string) {
  const chars = Array.from(text);
  return chars.length <= 96 ? text : `${chars.slice(0, 96).join("").trimEnd()}…`;
}

function completedLabel(status: MessageStatus, durationMs?: number) {
  if (status === "failed") return "任务执行失败";
  if (status === "cancelled") return "任务已取消";
  return durationMs !== undefined ? `已完成，耗时${formatDuration(durationMs)}` : "已完成";
}

function timelineIconKind(
  tool: RuntimeToolCall,
  isRunning: boolean,
  isFailed: boolean
): TimelineIconKind {
  if (isRunning) return "loading";
  if (isFailed) return "warning";
  const key = tool.name.toLowerCase();
  if (
    key.includes("read") ||
    key.includes("file") ||
    key.includes("fetch") ||
    key.includes("doc")
  ) {
    return "read";
  }
  if (
    key.includes("search") ||
    key.includes("query") ||
    key.includes("list") ||
    key.includes("retrieval")
  ) {
    return "search";
  }
  if (tool.status === "succeeded") return "success";
  return "tool";
}

function formatToolAction(tool: RuntimeToolCall) {
  const name = toolActionText(tool);
  if (tool.status === "running") return `正在执行 ${name}`;
  if (tool.status === "failed") return `${name} 调用失败`;
  if (tool.status === "cancelled") return `${name} 已取消`;
  return name;
}

function toolActionText(tool: RuntimeToolCall) {
  const name = normalizeToolName(tool.name);
  const key = name.toLowerCase();
  const args =
    tool.arguments && typeof tool.arguments === "object"
      ? (tool.arguments as Record<string, unknown>)
      : {};
  const path = firstString(args.path, args.file, args.filename, args.file_path, args.url);
  const query = firstString(args.query, args.keyword, args.keywords, args.q);

  if (key.includes("query rewrite")) return "查询改写";
  if (key.includes("hybrid retrieval")) return "混合检索";
  if (key.includes("rerank")) return "重排序";
  if (key.includes("answer generation")) return "生成答案";
  if (
    key.includes("exchange") ||
    key.includes("redeem") ||
    key.includes("兑换") ||
    key.includes("igg")
  ) {
    return query ? `执行兑换 "${query}"` : "执行兑换流程";
  }
  if (key.includes("read") || key.includes("fetch") || key.includes("file")) {
    return path ? `阅读 "${path}"` : "阅读文件";
  }
  if (key.includes("search") || key.includes("query") || key.includes("list")) {
    return query ? `搜索 "${query}"` : "工具检索";
  }
  return name;
}

function normalizeToolName(name: string) {
  return name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}
