"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  CircleDot,
  FileSearch,
  GitBranch,
  Search,
  Wrench,
  XCircle,
} from "lucide-react";
import type {
  MessageStatus,
  RuntimeReasoningStep,
  RuntimeToolCall,
} from "@/lib/types";

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

export function ReasoningTrace({
  steps,
  toolCalls,
  answerContent,
  isStreaming,
  durationMs,
  status,
}: ReasoningTraceProps) {
  const [expanded, setExpanded] = useState(isStreaming);
  const [observedDurationMs, setObservedDurationMs] = useState(durationMs);
  const startedAtRef = useRef<number | null>(isStreaming ? Date.now() : null);
  const wasStreamingRef = useRef(isStreaming);
  const rounds = useMemo(
    () => buildReasoningRounds(steps ?? [], toolCalls ?? []),
    [steps, toolCalls]
  );
  const toolCount = useMemo(
    () => rounds.reduce((count, round) => count + round.tool_calls.length, 0),
    [rounds]
  );

  useEffect(() => {
    if (isStreaming) {
      if (startedAtRef.current === null) startedAtRef.current = Date.now();
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
    if (durationMs !== undefined) setObservedDurationMs(durationMs);
  }, [durationMs]);

  if (toolCount === 0) return null;

  return (
    <section
      className={`dm-reasoning-trace ${expanded ? "expanded" : ""} ${
        isStreaming ? "running" : "completed"
      }`}
      data-testid="reasoning-trace"
    >
      <button
        aria-expanded={expanded}
        className="dm-reasoning-toggle dm-reasoning-summary"
        onClick={() => setExpanded((value) => !value)}
        title="展开或收起思维链"
        type="button"
      >
        <GitBranch aria-hidden="true" size={14} />
        <span>{traceLabel(status, isStreaming, rounds.length, toolCount, observedDurationMs)}</span>
        <ChevronDown className="dm-reasoning-chevron" size={15} />
      </button>

      {expanded ? (
        <div className="dm-reasoning-detail">
          <div className="dm-reasoning-rounds">
            {rounds.map((round) => (
              <ReasoningRoundCard
                answerContent={answerContent}
                isStreaming={isStreaming}
                key={round.step}
                round={round}
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ReasoningRoundCard({
  round,
  answerContent,
  isStreaming,
}: {
  round: ReasoningRound;
  answerContent: string;
  isStreaming: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const roundStatus = reasoningRoundStatus(round, isStreaming);
  const output = reasoningRoundOutput(round, answerContent);

  return (
    <article
      className={`dm-reasoning-round is-${roundStatus}`}
      data-reasoning-step={round.step}
    >
      <button
        aria-expanded={expanded}
        className="dm-reasoning-round-head"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span className="dm-reasoning-round-index">{round.step}</span>
        <span className="dm-reasoning-round-title">
          <strong>第 {round.step} 轮迭代</strong>
          <small>{roundSubtitle(round, roundStatus)}</small>
        </span>
        <RoundStatusIcon status={roundStatus} />
        <ChevronDown className="dm-reasoning-round-chevron" size={15} />
      </button>

      {expanded ? (
        <div className="dm-reasoning-round-body">
          {output ? (
            <ReasoningOutput
              label={round.action === "respond" ? "对话输出" : "本轮输出"}
              text={output}
            />
          ) : null}

          {round.tool_calls.length > 0 ? (
            <section className="dm-reasoning-tool-section">
              <div className="dm-reasoning-section-label">
                <Wrench aria-hidden="true" size={13} />
                <span>工具调用</span>
                <b>{round.tool_calls.length}</b>
              </div>
              <div className="dm-reasoning-tools">
                {round.tool_calls.map((tool) => (
                  <ToolCallCard key={tool.id} tool={tool} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function ReasoningOutput({ label, text }: { label: string; text: string }) {
  const [showAll, setShowAll] = useState(false);
  const long = Array.from(text).length > 420;

  return (
    <section className="dm-reasoning-output">
      <div className="dm-reasoning-section-label">
        <CircleDot aria-hidden="true" size={13} />
        <span>{label}</span>
      </div>
      <div className={`dm-reasoning-output-text ${showAll ? "is-expanded" : ""}`}>{text}</div>
      {long ? (
        <button
          className="dm-reasoning-show-all"
          onClick={() => setShowAll((value) => !value)}
          type="button"
        >
          {showAll ? "收起全文" : "展开全文"}
        </button>
      ) : null}
    </section>
  );
}

function ToolCallCard({ tool }: { tool: RuntimeToolCall }) {
  const [expanded, setExpanded] = useState(true);
  const failed = tool.status === "failed" || tool.status === "cancelled";
  const result = failed ? tool.error ?? tool.result : tool.result;
  const duration =
    tool.duration_ms !== undefined && tool.status !== "running"
      ? formatDuration(tool.duration_ms)
      : null;

  return (
    <article className={`dm-tool-call-card is-${tool.status}`} data-tool-name={tool.name}>
      <button
        aria-expanded={expanded}
        className="dm-tool-call-head"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span className="dm-tool-call-icon">{toolIcon(tool)}</span>
        <span className="dm-tool-call-title">
          <strong>{toolActionText(tool)}</strong>
          <code>{tool.name}</code>
        </span>
        {duration ? <span className="dm-tool-call-duration">{duration}</span> : null}
        <span className={`dm-tool-call-status is-${tool.status}`}>{toolStatusLabel(tool)}</span>
        <ChevronDown className="dm-tool-call-chevron" size={14} />
      </button>

      {expanded ? (
        <div className="dm-tool-call-body">
          <ToolPayload
            emptyText="没有收到调用参数"
            label="调用参数"
            value={tool.arguments ?? tool.arguments_preview}
          />
          <ToolPayload
            emptyText={tool.status === "running" ? "等待工具返回…" : "工具没有返回正文"}
            failed={failed}
            label={failed ? "错误信息" : "工具结果"}
            value={result}
          />
        </div>
      ) : null}
    </article>
  );
}

function ToolPayload({
  label,
  value,
  emptyText,
  failed = false,
}: {
  label: string;
  value: unknown;
  emptyText: string;
  failed?: boolean;
}) {
  const content = formatPayload(value);
  return (
    <section className={`dm-tool-payload ${failed ? "is-error" : ""}`}>
      <div className="dm-tool-payload-label">{label}</div>
      <pre>{content || emptyText}</pre>
    </section>
  );
}

function buildReasoningRounds(
  steps: RuntimeReasoningStep[],
  liveTools: RuntimeToolCall[]
): ReasoningRound[] {
  const rounds = new Map<number, ReasoningRound>();
  const upsertRound = (stepNumber: number, step?: RuntimeReasoningStep) => {
    const existing = rounds.get(stepNumber);
    if (!existing) {
      const next: ReasoningRound = {
        step: stepNumber,
        action: step?.action ?? "tool",
        decision_summary: step?.decision_summary ?? "",
        output: step?.output,
        tool_calls: [],
        warnings: step?.warnings,
        started_at: step?.started_at,
        completed_at: step?.completed_at,
      };
      rounds.set(stepNumber, next);
      return next;
    }
    if (step) {
      if (step.action === "respond" || existing.action === "tool") existing.action = step.action;
      if (!existing.decision_summary && step.decision_summary) {
        existing.decision_summary = step.decision_summary;
      }
      if (!existing.output && step.output) existing.output = step.output;
      existing.warnings = [...(existing.warnings ?? []), ...(step.warnings ?? [])];
      existing.started_at ??= step.started_at;
      existing.completed_at = step.completed_at ?? existing.completed_at;
    }
    return existing;
  };
  const mergeTool = (round: ReasoningRound, tool: RuntimeToolCall) => {
    const index = round.tool_calls.findIndex((candidate) => candidate.id === tool.id);
    if (index === -1) round.tool_calls.push(tool);
    else round.tool_calls[index] = { ...round.tool_calls[index], ...tool };
  };

  for (const step of [...steps].sort((a, b) => a.step - b.step)) {
    const round = upsertRound(step.step, step);
    for (const tool of step.tool_calls ?? []) mergeTool(round, { ...tool, step: step.step });
  }

  const fallbackStep = Math.max(
    1,
    ...Array.from(rounds.values())
      .filter((round) => round.action !== "respond")
      .map((round) => round.step)
  );
  for (const tool of liveTools) {
    const stepNumber = tool.step ?? fallbackStep;
    mergeTool(upsertRound(stepNumber), tool);
  }

  return Array.from(rounds.values())
    .filter((round) => round.tool_calls.length > 0 || round.action === "respond")
    .sort((a, b) => a.step - b.step);
}

type ReasoningRoundStatus = "running" | "completed" | "failed";

function reasoningRoundStatus(
  round: ReasoningRound,
  isStreaming: boolean
): ReasoningRoundStatus {
  if (
    round.tool_calls.some(
      (tool) => tool.status === "failed" || tool.status === "cancelled"
    ) ||
    (round.warnings?.length ?? 0) > 0
  ) {
    return "failed";
  }
  if (
    round.tool_calls.some((tool) => tool.status === "running") ||
    (round.action === "respond" && isStreaming)
  ) {
    return "running";
  }
  return "completed";
}

function RoundStatusIcon({ status }: { status: ReasoningRoundStatus }) {
  if (status === "running") return <span className="dm-action-spinner" aria-label="执行中" />;
  if (status === "failed") return <XCircle aria-label="执行异常" size={15} />;
  return <CheckCircle2 aria-label="执行完成" size={15} />;
}

function reasoningRoundOutput(round: ReasoningRound, answerContent: string) {
  if (round.action === "respond") return round.output?.trim() || answerContent.trim();
  if (round.output?.trim()) return round.output.trim();
  for (const tool of round.tool_calls) {
    if (!tool.arguments || typeof tool.arguments !== "object") continue;
    const reason = (tool.arguments as Record<string, unknown>).reason;
    if (typeof reason === "string" && reason.trim()) return reason.trim();
  }
  if (round.tool_calls.length > 0) {
    return `调用 ${round.tool_calls.map((tool) => toolActionText(tool)).join("、")} 获取所需信息。`;
  }
  return humanizeDecisionSummary(round.decision_summary);
}

function humanizeDecisionSummary(summary: string) {
  if (!summary) return "";
  if (summary === "direct response without tools") return "直接生成回复。";
  if (summary === "grounded response from accumulated evidence") {
    return "根据已获得的证据生成回复。";
  }
  return summary
    .replace(/^model selected tools:\s*/i, "选择工具：")
    .replace(/^executed\s+/i, "已调用 ");
}

function roundSubtitle(round: ReasoningRound, status: ReasoningRoundStatus) {
  if (status === "failed") return "执行异常";
  if (status === "running") {
    return round.action === "respond" ? "输出回复" : "调用工具";
  }
  if (round.action === "respond") return "对话输出";
  return `${round.tool_calls.length} 次工具调用`;
}

function traceLabel(
  status: MessageStatus,
  isStreaming: boolean,
  roundCount: number,
  toolCount: number,
  durationMs?: number
) {
  const state = isStreaming
    ? "执行中"
    : status === "failed"
      ? "执行异常"
      : status === "cancelled"
        ? "已取消"
        : "执行完成";
  const duration =
    !isStreaming && durationMs !== undefined ? ` · ${formatDuration(durationMs)}` : "";
  return `${state} · ${roundCount} 轮 · ${toolCount} 次工具调用${duration}`;
}

function toolStatusLabel(tool: RuntimeToolCall) {
  if (tool.status === "running") return "执行中";
  if (tool.status === "failed") return "失败";
  if (tool.status === "cancelled") return "已取消";
  return "已完成";
}

function toolIcon(tool: RuntimeToolCall) {
  const key = tool.name.toLowerCase();
  if (key.includes("search") || key.includes("query") || key.includes("retrieval")) {
    return <Search aria-hidden="true" size={14} />;
  }
  if (key.includes("read") || key.includes("file") || key.includes("fetch")) {
    return <FileSearch aria-hidden="true" size={14} />;
  }
  return <Wrench aria-hidden="true" size={14} />;
}

function toolActionText(tool: RuntimeToolCall) {
  const name = normalizeToolName(tool.name);
  const key = name.toLowerCase();
  const args =
    tool.arguments && typeof tool.arguments === "object"
      ? (tool.arguments as Record<string, unknown>)
      : {};
  const path = firstString(args.path, args.file, args.filename, args.file_path, args.url);
  const query = firstString(
    args.query,
    args.keyword,
    args.q,
    Array.isArray(args.queries) ? args.queries[0] : undefined
  );

  if (key.includes("knowledge search")) return query ? `检索“${query}”` : "知识库检索";
  if (key.includes("query rewrite")) return "查询改写";
  if (key.includes("hybrid retrieval")) return "混合检索";
  if (key.includes("rerank")) return "重排序";
  if (key.includes("answer generation")) return "生成答案";
  if (key.includes("read") || key.includes("fetch") || key.includes("file")) {
    return path ? `阅读“${path}”` : "阅读文件";
  }
  if (key.includes("search") || key.includes("query") || key.includes("list")) {
    return query ? `搜索“${query}”` : "工具检索";
  }
  return name || "工具调用";
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

function formatPayload(value: unknown) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return trimmed;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}
