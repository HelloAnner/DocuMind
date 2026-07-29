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
import type { PipelineStage } from "@/hooks/use-conversation-manager";
import type { MessageStatus, RuntimeToolCall } from "@/lib/types";

interface ReasoningTraceProps {
  thinking?: string;
  toolCalls?: RuntimeToolCall[];
  stages?: PipelineStage[];
  isStreaming: boolean;
  durationMs?: number;
  status: MessageStatus;
  processingStarted: boolean;
}

const PIPELINE_TOOL_NAMES = new Set([
  "query_rewrite",
  "hybrid_retrieval",
  "rerank",
  "answer_generation",
]);

export function ReasoningTrace({
  thinking,
  toolCalls,
  stages,
  isStreaming,
  durationMs,
  status,
  processingStarted,
}: ReasoningTraceProps) {
  const [expanded, setExpanded] = useState(isStreaming);
  const wasStreamingRef = useRef(isStreaming);
  const visibleTools = useMemo(
    () => mergeRuntimeAndPipelineTools(toolCalls ?? [], isStreaming ? stages : undefined),
    [isStreaming, stages, toolCalls]
  );
  const thinkingLines = useMemo(() => splitThinkingLines(thinking ?? ""), [thinking]);
  const hasTrace = thinkingLines.length > 0 || visibleTools.length > 0;

  useEffect(() => {
    if (isStreaming) {
      setExpanded(true);
    } else if (wasStreamingRef.current) {
      setExpanded(false);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  if (!isStreaming && !hasTrace) return null;

  const runningMode =
    processingStarted || Boolean(toolCalls?.length) ? "processing" : "thinking";
  const canExpand = hasTrace;

  return (
    <section
      className={`dm-reasoning-trace ${expanded ? "expanded" : ""} ${isStreaming ? "running" : "completed"}`}
      data-testid="reasoning-trace"
    >
      {isStreaming ? (
        <div className="dm-reasoning-running-head" role="status" aria-live="polite">
          <span className="dm-reasoning-running-text">
            {runningMode === "processing" ? "正在处理中..." : "正在思考..."}
          </span>
        </div>
      ) : (
        <button
          aria-expanded={canExpand ? expanded : undefined}
          className="dm-reasoning-toggle dm-reasoning-summary"
          disabled={!canExpand}
          onClick={() => canExpand && setExpanded((value) => !value)}
          title={canExpand ? "展开或收起工作过程" : undefined}
          type="button"
        >
          <span>{completedLabel(status, durationMs)}</span>
          {canExpand ? <ChevronDown className="dm-reasoning-chevron" size={16} /> : null}
        </button>
      )}

      {expanded && hasTrace ? (
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
  const hasDetails =
    tool.arguments !== undefined ||
    Boolean(tool.arguments_preview) ||
    Boolean(tool.result) ||
    Boolean(tool.message) ||
    tool.progress !== undefined ||
    Boolean(tool.display);

  return (
    <div className="action-feed-tool-row">
      <div className="action-feed-row">
        <TimelineIconSlot kind={timelineIconKind(tool, isRunning, isFailed)} />
        <span className={`action-feed-row-text ${isRunning ? "is-strong" : ""}`}>
          {formatToolAction(tool)}
        </span>
        {duration ? <span className="action-feed-duration">{duration}</span> : null}
      </div>
      {hasDetails ? (
        <details className="action-feed-details">
          <summary>查看调用细节</summary>
          {tool.message ? (
            <div className="action-feed-detail-block">
              <div className="action-feed-detail-label">状态</div>
              <pre>{tool.message}</pre>
            </div>
          ) : null}
          {tool.progress !== undefined ? (
            <div className="action-feed-progress">
              <span style={{ width: `${Math.min(100, Math.max(0, tool.progress))}%` }} />
            </div>
          ) : null}
          {tool.arguments !== undefined || tool.arguments_preview ? (
            <div className="action-feed-detail-block">
              <div className="action-feed-detail-label">参数</div>
              <pre>
                {tool.arguments !== undefined
                  ? formatValue(tool.arguments)
                  : tool.arguments_preview}
              </pre>
            </div>
          ) : null}
          {tool.display !== undefined ? <ToolDisplayCard display={tool.display} /> : null}
          {tool.result ? (
            <div className="action-feed-detail-block">
              <div className="action-feed-detail-label">结果</div>
              <pre>{tool.result}</pre>
            </div>
          ) : null}
        </details>
      ) : null}
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

function ToolDisplayCard({ display }: { display: unknown }) {
  if (!display || typeof display !== "object") return null;
  const value = display as { component?: unknown; data?: unknown };
  const title = typeof value.component === "string" ? value.component : "工具结果";
  const data =
    value.data && typeof value.data === "object"
      ? (value.data as Record<string, unknown>)
      : {};
  const label = firstString(data.label, data.title, data.name, title);
  const rows = Object.entries(data).filter(
    ([key]) => key !== "label" && key !== "title" && key !== "name"
  );

  return (
    <div className="dm-tool-display-card">
      <div className="dm-tool-display-head">
        <span>{label}</span>
        <small>{title}</small>
      </div>
      {rows.length > 0 ? (
        <div className="dm-tool-display-grid">
          {rows.slice(0, 6).map(([key, rowValue]) => (
            <div key={key}>
              <small>{humanizeKey(key)}</small>
              <span>{formatCompactValue(rowValue)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function mergeRuntimeAndPipelineTools(
  toolCalls: RuntimeToolCall[],
  stages?: PipelineStage[]
): RuntimeToolCall[] {
  const runtimePipelineNames = new Set(
    toolCalls
      .map((tool) => tool.name.toLowerCase())
      .filter((name) => PIPELINE_TOOL_NAMES.has(name))
  );
  const pipelineTools = (stages ?? [])
    .filter((stage) => stage.done || stage.running)
    .map((stage): RuntimeToolCall => {
      const name = pipelineToolName(stage.label);
      return {
        id: `pipeline-${name}`,
        name,
        status: stage.done ? "succeeded" : "running",
      };
    })
    .filter((tool) => !runtimePipelineNames.has(tool.name));

  return [...pipelineTools, ...toolCalls];
}

function pipelineToolName(label: string) {
  if (label === "查询改写") return "query_rewrite";
  if (label === "混合检索") return "hybrid_retrieval";
  if (label === "重排序") return "rerank";
  if (label === "生成答案") return "answer_generation";
  return label;
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

function formatValue(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function humanizeKey(key: string) {
  return key.replace(/[_-]+/g, " ");
}

function formatCompactValue(value: unknown) {
  if (value === null || value === undefined) return "-";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) return `${value.length} 项`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
