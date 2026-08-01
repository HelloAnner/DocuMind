"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { MessageStatus, RuntimeReasoningStep, RuntimeToolCall } from "@/lib/types";

interface ReasoningTraceProps {
  steps?: RuntimeReasoningStep[];
  toolCalls?: RuntimeToolCall[];
  answerContent: string;
  isStreaming: boolean;
  durationMs?: number;
  status: MessageStatus;
}

interface ReasoningRound extends RuntimeReasoningStep {
  tool_calls: RuntimeToolCall[];
}

type RoundStatus = "running" | "completed" | "failed";

export function ReasoningTrace({
  steps,
  toolCalls,
  isStreaming,
  durationMs,
  status,
}: ReasoningTraceProps) {
  const [expanded, setExpanded] = useState(isStreaming);
  const [mounted, setMounted] = useState(isStreaming);
  const [observedDurationMs, setObservedDurationMs] = useState(durationMs);
  const startedAtRef = useRef<number | null>(isStreaming ? Date.now() : null);
  const wasStreamingRef = useRef(isStreaming);
  const releaseTimerRef = useRef<number | undefined>(undefined);
  const feedRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const rounds = useMemo(() => buildReasoningRounds(steps ?? [], toolCalls ?? []), [steps, toolCalls]);
  const toolCount = rounds.reduce((count, round) => count + round.tool_calls.length, 0);

  useEffect(() => {
    if (isStreaming) {
      if (startedAtRef.current === null) startedAtRef.current = Date.now();
      window.clearTimeout(releaseTimerRef.current);
      setMounted(true);
      setExpanded(true);
    } else if (wasStreamingRef.current) {
      if (durationMs === undefined && startedAtRef.current !== null) {
        setObservedDurationMs(Math.max(1, Date.now() - startedAtRef.current));
      }
      startedAtRef.current = null;
      setExpanded(false);
      releaseTimerRef.current = window.setTimeout(() => setMounted(false), 60_000);
    }
    wasStreamingRef.current = isStreaming;
    return () => window.clearTimeout(releaseTimerRef.current);
  }, [durationMs, isStreaming]);

  useEffect(() => {
    if (durationMs !== undefined) setObservedDurationMs(durationMs);
  }, [durationMs]);

  useEffect(() => {
    const feed = feedRef.current;
    if (expanded && autoScrollRef.current && feed) feed.scrollTop = feed.scrollHeight;
  }, [expanded, rounds]);

  if (toolCount === 0) return null;

  function toggle() {
    if (isStreaming) return;
    setExpanded((current) => {
      const next = !current;
      window.clearTimeout(releaseTimerRef.current);
      if (next) {
        setMounted(true);
        requestAnimationFrame(() => feedRef.current?.scrollIntoView({ block: "nearest" }));
      } else {
        releaseTimerRef.current = window.setTimeout(() => setMounted(false), 60_000);
      }
      return next;
    });
  }

  return (
    <section
      className={`dm-reasoning-trace ${expanded ? "expanded" : ""} ${isStreaming ? "running" : "completed"}`}
      data-testid="reasoning-trace"
    >
      {isStreaming ? (
        <div className="dm-reasoning-running">正在处理中...</div>
      ) : (
        <button
          aria-expanded={expanded}
          className="dm-reasoning-toggle"
          onClick={toggle}
          title="展开或收起工作过程"
          type="button"
        >
          <span>{traceLabel(status, observedDurationMs)}</span>
          <ChevronDown aria-hidden="true" className="dm-reasoning-chevron" size={16} />
        </button>
      )}

      {expanded && mounted ? (
        <div
          className="dm-reasoning-feed"
          onScroll={(event) => {
            const target = event.currentTarget;
            autoScrollRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 10;
          }}
          ref={feedRef}
        >
          {rounds.map((round, index) => (
            <ProcessGroup
              hasFollowing={index < rounds.length - 1}
              isStreaming={isStreaming}
              key={round.step}
              round={round}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ProcessGroup({
  round,
  isStreaming,
  hasFollowing,
}: {
  round: ReasoningRound;
  isStreaming: boolean;
  hasFollowing: boolean;
}) {
  const roundStatus = reasoningRoundStatus(round, isStreaming);
  const note = processNote(round);
  return (
    <div className="dm-process-group" data-reasoning-step={round.step}>
      {(round.tool_calls.length > 0 || hasFollowing) ? (
        <span aria-hidden="true" className={`dm-process-connector${hasFollowing ? " continues" : ""}`} />
      ) : null}
      <div className="dm-process-row">
        <span className="dm-process-icon-slot">
          <ProcessIcon status={roundStatus} />
        </span>
        <ThinkingPreview text={note} />
      </div>
      {round.tool_calls.length ? (
        <div className="dm-process-tools">
          {round.tool_calls.map((tool) => <ToolAction key={tool.id} tool={tool} />)}
        </div>
      ) : null}
    </div>
  );
}

function ThinkingPreview({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const plain = markdownToPlainText(text);
  const preview = thinkingPreview(plain);
  const truncated = Array.from(plain).length > Array.from(preview).length;
  return (
    <span className="dm-process-copy">
      {expanded ? plain : preview}
      {truncated && !expanded ? (
        <button className="dm-process-more" onClick={() => setExpanded(true)} type="button">更多</button>
      ) : null}
    </span>
  );
}

function ProcessIcon({ status }: { status: RoundStatus }) {
  if (status === "running") return <span aria-label="执行中" className="dm-process-spinner" />;
  if (status === "failed") {
    return (
      <svg aria-label="执行异常" height="14" viewBox="0 0 14 14" width="14">
        <path d="M7 0a7 7 0 1 1 0 14A7 7 0 0 1 7 0Zm0 1.125A5.875 5.875 0 1 0 7 12.875 5.875 5.875 0 0 0 7 1.125Zm0 8.25a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm0-6.75a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 7 2.625Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg aria-label="执行完成" height="14" viewBox="0 0 16 16" width="14">
      <circle cx="8" cy="8" fill="currentColor" r="8" />
      <path d="m4.25 8.1 2.5 2.4 5-5" fill="none" stroke="var(--bg-primary)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function ToolAction({ tool }: { tool: RuntimeToolCall }) {
  const running = tool.status === "running";
  const failed = tool.status === "failed" || tool.status === "cancelled";
  return (
    <div className={`dm-process-tool ${running ? "is-running" : ""} ${failed ? "is-failed" : ""}`}>
      <span className="dm-process-tool-icon"><ToolIcon kind={toolIconKind(tool)} /></span>
      <span className="dm-process-tool-copy">{toolActionText(tool)}</span>
      {!running && tool.duration_ms !== undefined ? (
        <span className="dm-process-duration">{formatDuration(tool.duration_ms)}</span>
      ) : null}
    </div>
  );
}

function ToolIcon({ kind }: { kind: "read" | "search" | "draw" | "warning" | "loading" }) {
  if (kind === "loading") return <span className="dm-process-spinner small" />;
  if (kind === "read") {
    return <svg height="14" viewBox="0 0 12.5 14" width="12.5"><path d="M10.5 0A2 2 0 0 1 12.5 2v10a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h8.5ZM2.125 1.125a1 1 0 0 0-1 1v9.75a1 1 0 0 0 1 1H3.25V1.125H2.125Zm2.25 11.75h6a1 1 0 0 0 1-1v-9.75a1 1 0 0 0-1-1h-6v11.75ZM9.312 5.875a.563.563 0 0 1 0 1.125H6.438a.563.563 0 0 1 0-1.125h2.874Zm0-2.625a.563.563 0 0 1 0 1.125H6.438a.563.563 0 0 1 0-1.125h2.874Z" fill="currentColor" /></svg>;
  }
  if (kind === "draw") {
    return <svg height="13" viewBox="0 0 13 13" width="13"><path d="M3.5 6a.56.56 0 1 1 0 1.12H2.1a.97.97 0 0 0 0 1.94h8.62a1.97 1.97 0 1 1 0 3.94H5.5a.56.56 0 1 1 0-1.13h5.22a.84.84 0 1 0 0-1.68H2.1A2.1 2.1 0 0 1 2.1 6h1.4ZM8.9.46a1.56 1.56 0 0 1 2.21 0l1.13 1.12a1.56 1.56 0 0 1 0 2.21L9.16 6.87c-.29.29-.69.46-1.1.46l-1.13.01a1.56 1.56 0 0 1-1.56-1.57V4.64c0-.41.16-.81.46-1.1L8.9.46Z" fill="currentColor" /></svg>;
  }
  if (kind === "warning") return <ProcessIcon status="failed" />;
  return <svg fill="none" height="14" viewBox="0 0 14 14" width="14"><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" /><path d="m9.5 9.5 3 3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" /></svg>;
}

function buildReasoningRounds(steps: RuntimeReasoningStep[], liveTools: RuntimeToolCall[]) {
  const rounds = new Map<number, ReasoningRound>();
  const getRound = (step: number, source?: RuntimeReasoningStep) => {
    const current = rounds.get(step);
    if (current) {
      if (source) Object.assign(current, source, { tool_calls: current.tool_calls });
      return current;
    }
    const next: ReasoningRound = {
      step,
      action: source?.action ?? "tool",
      decision_summary: source?.decision_summary ?? "",
      output: source?.output,
      tool_calls: [],
      warnings: source?.warnings,
      started_at: source?.started_at,
      completed_at: source?.completed_at,
    };
    rounds.set(step, next);
    return next;
  };
  const mergeTool = (round: ReasoningRound, tool: RuntimeToolCall) => {
    const index = round.tool_calls.findIndex((item) => item.id === tool.id);
    if (index < 0) round.tool_calls.push(tool);
    else round.tool_calls[index] = { ...round.tool_calls[index], ...tool };
  };

  for (const step of [...steps].sort((a, b) => a.step - b.step)) {
    const round = getRound(step.step, step);
    for (const tool of step.tool_calls ?? []) mergeTool(round, tool);
  }
  const fallbackStep = Math.max(
    1,
    ...Array.from(rounds.values()).filter((round) => round.action !== "respond").map((round) => round.step)
  );
  for (const tool of liveTools) mergeTool(getRound(tool.step ?? fallbackStep), tool);
  return Array.from(rounds.values())
    .filter((round) => round.tool_calls.length > 0 || round.action === "respond")
    .sort((a, b) => a.step - b.step);
}

function reasoningRoundStatus(round: ReasoningRound, streaming: boolean): RoundStatus {
  if ((round.warnings?.length ?? 0) > 0 || round.tool_calls.some((tool) => tool.status === "failed" || tool.status === "cancelled")) return "failed";
  if (round.tool_calls.some((tool) => tool.status === "running") || (round.action === "respond" && streaming)) return "running";
  return "completed";
}

function processNote(round: ReasoningRound) {
  const summary = humanizeDecisionSummary(round.decision_summary);
  if (summary) return summary;
  for (const tool of round.tool_calls) {
    if (!tool.arguments || typeof tool.arguments !== "object") continue;
    const reason = (tool.arguments as Record<string, unknown>).reason;
    if (typeof reason === "string" && reason.trim()) return reason.trim();
  }
  if (round.action === "respond") return "根据已获得的证据生成回复。";
  return "调用工具进行深度洞察...";
}

function humanizeDecisionSummary(summary: string) {
  if (!summary || summary === "direct response without tools") return "";
  if (summary === "grounded response from accumulated evidence") return "根据已获得的证据生成回复。";
  return summary.replace(/^model selected tools:\s*/i, "选择工具：").replace(/^executed\s+/i, "已调用 ");
}

function thinkingPreview(text: string) {
  if (Array.from(text).length <= 96) return text;
  const sentences = text.match(/[^。！？!?；;]+[。！？!?；;]?/g)?.map((item) => item.trim()).filter(Boolean) ?? [];
  let preview = "";
  for (const sentence of sentences) {
    if (Array.from(preview + sentence).length > 96) break;
    preview += sentence;
  }
  return preview || Array.from(text).slice(0, 96).join("").trimEnd();
}

function markdownToPlainText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, "").replace(/```/g, " "))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function toolIconKind(tool: RuntimeToolCall): "read" | "search" | "draw" | "warning" | "loading" {
  if (tool.status === "running") return "loading";
  if (tool.status === "failed" || tool.status === "cancelled") return "warning";
  const key = tool.name.toLowerCase();
  if (key.includes("read") || key.includes("file") || key.includes("fetch")) return "read";
  if (key.includes("write") || key.includes("edit") || key.includes("todo")) return "draw";
  return "search";
}

function toolActionText(tool: RuntimeToolCall) {
  const name = tool.name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const key = name.toLowerCase();
  const args = tool.arguments && typeof tool.arguments === "object" ? tool.arguments as Record<string, unknown> : {};
  const path = firstString(args.path, args.file, args.filename, args.file_path, args.url);
  const query = firstString(args.query, args.keyword, args.q, Array.isArray(args.queries) ? args.queries[0] : undefined);
  if (key.includes("knowledge search")) return query ? `检索“${query}”` : "知识库检索";
  if (key.includes("query rewrite")) return "查询改写";
  if (key.includes("hybrid retrieval")) return "混合检索";
  if (key.includes("rerank")) return "重排序";
  if (key.includes("answer generation")) return "生成答案";
  if (key.includes("read") || key.includes("fetch") || key.includes("file")) return path ? `阅读“${path}”` : "阅读文件";
  if (key.includes("search") || key.includes("query") || key.includes("list")) return query ? `搜索“${query}”` : "工具检索";
  if (key.includes("todo")) return "更新任务清单";
  return name || "工具调用";
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim() ?? "";
}

function traceLabel(status: MessageStatus, durationMs?: number) {
  if (status === "failed") return "任务执行失败";
  if (status === "cancelled") return "任务已取消";
  return durationMs === undefined ? "已完成" : `已完成，耗时${formatDuration(durationMs)}`;
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}
