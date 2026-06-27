"use client";

import { useState } from "react";
import {
  Bot,
  Check,
  CheckCircle2,
  Circle,
  Copy,
  FileSearch,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Wrench,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { isCitationDeleted } from "./citation-card";
import { AnswerContent } from "./answer-content";
import type { Citation, Message, RuntimeToolCall } from "@/lib/types";
import type { PipelineStage } from "@/hooks/use-conversation-manager";

function CitationChip({
  citation,
  onClick,
}: {
  citation: Citation;
  onClick: (c: Citation) => void;
}) {
  const deleted = isCitationDeleted(citation);
  return (
    <button
      type="button"
      className={`dm-citation-chip ${deleted ? "deleted" : ""}`}
      onClick={() => onClick(citation)}
    >
      <span className="dm-citation-chip-index">[{citation.index}]</span>
      <span className="dm-citation-chip-doc">{citation.doc_title}</span>
      {citation.page_range.length > 0 && (
        <span className="dm-citation-chip-page">
          · 第 {citation.page_range.join("-")} 页
        </span>
      )}
      {deleted && <span className="dm-deleted-source-badge">原文已删除</span>}
    </button>
  );
}

function normalizeCitationText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function citationDedupKey(citation: Citation) {
  const anchor = citation.anchor;
  if (anchor) {
    const page = anchor.page ?? citation.page_range[0] ?? "";
    const slide = anchor.slide ?? "";
    const blocks = anchor.block_ids?.join(",") ?? "";
    const tables = anchor.table_ids?.join(",") ?? "";
    return [
      citation.doc_id || citation.doc_title,
      anchor.format ?? "",
      anchor.kind ?? "",
      page,
      slide,
      blocks,
      tables,
    ].join("::");
  }
  const doc = citation.doc_id || citation.doc_title;
  const pages = citation.page_range.join(",");
  const quote = normalizeCitationText(citation.quote);
  return `${doc}::${pages}::${quote}`;
}

function uniqueCitations(citations: Citation[]) {
  const seen = new Set<string>();
  const unique: Citation[] = [];

  for (const citation of citations) {
    const key = citationDedupKey(citation);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(citation);
  }

  return unique;
}

function citationByDisplayedSource(citations: Citation[]) {
  const byOriginalIndex = new Map<number, Citation>();
  const byKey = new Map<string, Citation>();

  for (const citation of citations) {
    const key = citationDedupKey(citation);
    const displayed = byKey.get(key) ?? citation;
    if (!byKey.has(key)) byKey.set(key, citation);
    byOriginalIndex.set(citation.index, displayed);
  }

  return byOriginalIndex;
}

interface MessageRowProps {
  message: Message;
  isStreaming: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onFeedback: (id: string) => void;
  onCitationClick: (c: Citation) => void;
  onFollowUp: (text: string) => void;
  stages?: PipelineStage[];
}

function StreamingIndicator() {
  return (
    <div className="dm-streaming-indicator action-feed-running">
      <span className="action-feed-running-text">正在思考...</span>
      <span className="dm-streaming-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

function AgentMeta({
  message,
  hasCitations,
  deletedAll,
}: {
  message: Message;
  hasCitations: boolean;
  deletedAll: boolean;
}) {
  const meta = [
    hasCitations ? `基于 ${message.citations.length} 个来源` : "",
    message.confidence ? `置信度 ${confidenceLabel(message.confidence)}` : "",
    deletedAll ? "来源已删除" : "",
  ].filter(Boolean);

  return (
    <div className="dm-answer-head">
      <span className="dm-answer-avatar">
        <Bot size={14} />
      </span>
      <div>
        <strong>DocuMind</strong>
        <p>{meta.length > 0 ? meta.join(" · ") : "DocuMind Agent · 知识库问答"}</p>
      </div>
    </div>
  );
}

function ReasoningTrace({
  thinking,
  toolCalls,
  stages,
  isStreaming,
  durationMs,
  hasSources,
  noAnswerReason,
}: {
  thinking?: string;
  toolCalls?: RuntimeToolCall[];
  stages?: PipelineStage[];
  isStreaming: boolean;
  durationMs?: number;
  hasSources?: boolean;
  noAnswerReason?: string;
}) {
  // 默认 RAG 管道阶段（查询改写/混合检索/重排序/生成答案）本身只是进度节点，
  // 不属于需要展示摘要的“工具调用”。只有真实工具/思考/来源/无答案原因才展示。
  const stageToolNames = new Set(["query_rewrite", "hybrid_retrieval", "rerank", "answer_generation"]);
  const meaningfulToolCalls = toolCalls?.filter((tool) => !stageToolNames.has(tool.name));
  const hasAtomTrace = Boolean(thinking?.trim()) || Boolean(meaningfulToolCalls?.length);
  const hasMeaningfulTrace = hasAtomTrace || hasSources || Boolean(noAnswerReason);

  // 纯寒暄/闲聊回复（无溯源、无真实工具链、无无答案原因）不需要展示执行过程摘要，
  // 避免用户一开口就只看到“全部工作已完成”。
  if (!isStreaming && !hasMeaningfulTrace) return null;
  if (!hasAtomTrace && (!stages || stages.length === 0)) return null;

  const statusText = isStreaming
    ? runningText(thinking, toolCalls)
    : durationMs
      ? `全部工作已完成，耗时${formatDuration(durationMs)}`
      : "全部工作已完成";

  return (
    <section className="dm-reasoning-trace">
      <div className="dm-reasoning-toggle dm-reasoning-summary">
        <Sparkles size={15} />
        <span>{statusText}</span>
      </div>
    </section>
  );
}

function ActionFeed({
  thinking,
  toolCalls,
  isRunning,
}: {
  thinking: string;
  toolCalls: RuntimeToolCall[];
  isRunning: boolean;
}) {
  const thinkingLines = thinking
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <div className="action-feed-panel">
      {isRunning && (
        <div className="action-feed-running">
          <span className="action-feed-running-text">
            {toolCalls.some((tool) => tool.status === "running") ? "正在处理中..." : "正在思考..."}
          </span>
        </div>
      )}

      {thinkingLines.map((line, index) => (
        <TimelineRow key={`${line}-${index}`} iconKind="tool" text={line} muted />
      ))}

      {toolCalls.map((tool) => (
        <ToolTimelineRow key={tool.id} tool={tool} />
      ))}
    </div>
  );
}

type TimelineIconKind = "read" | "search" | "tool" | "success" | "warning" | "loading";

function ToolTimelineRow({ tool }: { tool: RuntimeToolCall }) {
  const isRunning = tool.status === "running";
  const isFailed = tool.status === "failed" || tool.status === "cancelled";
  const duration = tool.duration_ms !== undefined && !isRunning ? formatDuration(tool.duration_ms) : null;
  const hasDetails =
    tool.arguments !== undefined ||
    Boolean(tool.arguments_preview) ||
    Boolean(tool.result) ||
    Boolean(tool.message) ||
    tool.progress !== undefined ||
    Boolean(tool.display);

  return (
    <div className="action-feed-tool-row">
      <TimelineRow
        iconKind={timelineIconKind(tool, isRunning, isFailed)}
        text={formatToolAction(tool)}
        duration={duration}
        strong={isRunning}
      />
      {hasDetails && (
        <details className="action-feed-details">
          <summary>查看调用细节</summary>
          {tool.message && (
            <div className="action-feed-detail-block">
              <div className="action-feed-detail-label">状态</div>
              <pre>{tool.message}</pre>
            </div>
          )}
          {tool.progress !== undefined && (
            <div className="action-feed-progress">
              <span style={{ width: `${Math.min(100, Math.max(0, tool.progress))}%` }} />
            </div>
          )}
          {tool.arguments !== undefined || tool.arguments_preview ? (
            <div className="action-feed-detail-block">
              <div className="action-feed-detail-label">参数</div>
              <pre>{tool.arguments !== undefined ? formatValue(tool.arguments) : tool.arguments_preview}</pre>
            </div>
          ) : null}
          {tool.display !== undefined && <ToolDisplayCard display={tool.display} />}
          {tool.result && (
            <div className="action-feed-detail-block">
              <div className="action-feed-detail-label">结果</div>
              <pre>{tool.result}</pre>
            </div>
          )}
        </details>
      )}
    </div>
  );
}

function ToolDisplayCard({ display }: { display: unknown }) {
  if (!display || typeof display !== "object") return null;
  const value = display as { component?: unknown; data?: unknown };
  const title = typeof value.component === "string" ? value.component : "工具结果";
  const data = value.data && typeof value.data === "object" ? value.data as Record<string, unknown> : {};
  const label = firstString(data.label, data.title, data.name, title);
  const rows = Object.entries(data).filter(([key]) => key !== "label" && key !== "title" && key !== "name");

  return (
    <div className="dm-tool-display-card">
      <div className="dm-tool-display-head">
        <span>{label}</span>
        <small>{title}</small>
      </div>
      {rows.length > 0 && (
        <div className="dm-tool-display-grid">
          {rows.slice(0, 6).map(([key, rowValue]) => (
            <div key={key}>
              <small>{humanizeKey(key)}</small>
              <span>{formatCompactValue(rowValue)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TimelineRow({
  iconKind,
  text,
  duration,
  muted = false,
  strong = false,
}: {
  iconKind: TimelineIconKind;
  text: string;
  duration?: string | null;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="action-feed-row">
      <span className="action-feed-icon-slot" aria-hidden="true">
        <span className="action-feed-icon-line action-feed-icon-line-top" />
        <span className="action-feed-icon">
          <TimelineIcon kind={iconKind} />
        </span>
        <span className="action-feed-icon-line action-feed-icon-line-bottom" />
      </span>
      <span className={`action-feed-row-text ${muted ? "is-muted" : ""} ${strong ? "is-strong" : ""}`}>
        {text}
      </span>
      {duration && <span className="action-feed-duration">{duration}</span>}
    </div>
  );
}

function TimelineIcon({ kind }: { kind: TimelineIconKind }) {
  if (kind === "loading") return <Loader2 className="spin" size={16} />;
  if (kind === "success") return <CheckCircle2 size={16} />;
  if (kind === "warning") return <XCircle size={16} />;
  if (kind === "read") return <FileSearch size={16} />;
  if (kind === "search") return <Search size={16} />;
  if (kind === "tool") return <Wrench size={16} />;
  return <Circle size={16} />;
}

function FollowUpQuestions({
  questions,
  onClick,
}: {
  questions?: { id: string; text: string }[];
  onClick: (text: string) => void;
}) {
  if (!questions || questions.length === 0) return null;
  return (
    <div className="dm-follow-up-questions">
      {questions.map((question) => (
        <button
          key={question.id}
          type="button"
          className="follow-up-question-button"
          onClick={() => onClick(question.text)}
        >
          <Sparkles size={13} />
          <span>{question.text}</span>
        </button>
      ))}
    </div>
  );
}

export function MessageRow({
  message,
  isStreaming,
  onRetry,
  onCancel,
  onFeedback,
  onCitationClick,
  onFollowUp,
  stages,
}: MessageRowProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (message.role === "user") {
    return (
      <div className="dm-question-row">
        <div className="dm-user-bubble">{message.content}</div>
      </div>
    );
  }

  const hasCitations = message.citations.length > 0;
  const displayCitations = uniqueCitations(message.citations);
  const citationLookup = citationByDisplayedSource(message.citations);
  const hasDisplayCitations = displayCitations.length > 0;
  const failed = message.status === "failed";
  const cancelled = message.status === "cancelled";
  const deletedAll = hasCitations && message.citations.every(isCitationDeleted);
  const hasContent = message.content.trim().length > 0;

  return (
    <article className={`dm-answer-card ${isStreaming ? "streaming" : ""}`}>
      <AgentMeta
        message={{ ...message, citations: displayCitations }}
        hasCitations={hasDisplayCitations}
        deletedAll={deletedAll}
      />

      <ReasoningTrace
        thinking={message.thinking}
        toolCalls={message.tool_calls}
        stages={stages}
        isStreaming={isStreaming}
        durationMs={message.duration_ms}
        hasSources={hasDisplayCitations}
        noAnswerReason={message.no_answer_reason}
      />

      {failed || cancelled ? (
        <div className="dm-answer-error">
          {cancelled ? "生成已取消" : message.content || "生成失败，请重试"}
        </div>
      ) : isStreaming && !hasContent ? (
        <StreamingIndicator />
      ) : hasContent ? (
        <AnswerContent
          content={message.content}
          citations={displayCitations}
          onCitationClick={(idx) => {
            const c = citationLookup.get(idx);
            if (c) onCitationClick(c);
          }}
        />
      ) : null}

      <FollowUpQuestions questions={message.follow_up_questions} onClick={onFollowUp} />

      {hasDisplayCitations && !isStreaming && (
        <div className="dm-answer-citations">
          <div className="dm-answer-citations-row">
            {displayCitations.map((citation) => (
              <CitationChip
                key={citation.index}
                citation={citation}
                onClick={onCitationClick}
              />
            ))}
          </div>
        </div>
      )}

      <div className="dm-answer-actions">
        <IconButton aria-label="复制" onClick={handleCopy}>
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </IconButton>
        <IconButton aria-label="点赞" onClick={() => onFeedback(message.message_id)}>
          <ThumbsUp size={16} />
        </IconButton>
        <IconButton aria-label="点踩" onClick={() => onFeedback(message.message_id)}>
          <ThumbsDown size={16} />
        </IconButton>
        {isStreaming ? (
          <Button variant="secondary" onClick={onCancel}>
            停止
          </Button>
        ) : failed || cancelled ? (
          <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={onRetry}>
            重试
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function confidenceLabel(c: "high" | "medium" | "low") {
  if (c === "high") return "高";
  if (c === "medium") return "中";
  return "低";
}

function runningText(thinking?: string, toolCalls?: RuntimeToolCall[]) {
  if (toolCalls?.some((tool) => tool.status === "running")) return "正在处理中...";
  if (thinking?.trim()) return "正在思考...";
  return "正在准备...";
}

function timelineIconKind(
  tool: RuntimeToolCall,
  isRunning: boolean,
  isFailed: boolean
): TimelineIconKind {
  if (isRunning) return "loading";
  if (isFailed) return "warning";
  const key = tool.name.toLowerCase();
  if (key.includes("read") || key.includes("file") || key.includes("fetch") || key.includes("doc")) return "read";
  if (key.includes("search") || key.includes("query") || key.includes("list") || key.includes("retrieval")) return "search";
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
  const args = tool.arguments && typeof tool.arguments === "object" ? tool.arguments as Record<string, unknown> : {};
  const path = firstString(args.path, args.file, args.filename, args.file_path, args.url);
  const query = firstString(args.query, args.keyword, args.keywords, args.q);

  if (key.includes("query rewrite")) return "查询改写";
  if (key.includes("hybrid retrieval")) return "混合检索";
  if (key.includes("rerank")) return "重排序";
  if (key.includes("answer generation")) return "生成答案";
  if (key.includes("exchange") || key.includes("redeem") || key.includes("兑换") || key.includes("igg")) {
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
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return `${value.length} 项`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
