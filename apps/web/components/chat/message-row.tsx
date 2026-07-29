"use client";

import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  RefreshCw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  citationLocationStatus,
  citationLocationStatusLabel,
  isCitationDeleted,
} from "./citation-card";
import { AnswerContent } from "./answer-content";
import { ReasoningTrace } from "./reasoning-trace";
import type { Citation, FeedbackReason, Message, Rating } from "@/lib/types";
import { AgentOrb } from "@/components/ui/brand-mark";
import { useAuth } from "@/components/providers/auth-provider";
import { copyToClipboard } from "@/lib/clipboard";

function CitationChip({
  citation,
  onClick,
}: {
  citation: Citation;
  onClick: (c: Citation) => void;
}) {
  const deleted = isCitationDeleted(citation);
  const locationStatus = citationLocationStatus(citation);
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
      <span className={`dm-location-badge dm-location-badge-${locationStatus}`}>
        {citationLocationStatusLabel(citation)}
      </span>
      {deleted && <span className="dm-deleted-source-badge">原文已删除</span>}
    </button>
  );
}

function normalizeCitationText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function formatRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
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
  onSubmitFeedback: (
    id: string,
    rating: Rating,
    reason?: FeedbackReason,
    comment?: string,
    correction?: string
  ) => Promise<boolean>;
  onClearFeedback: (id: string) => Promise<boolean>;
  onCitationClick: (c: Citation) => void;
  onFollowUp: (text: string) => void;
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
    deletedAll ? "来源已删除" : "",
  ].filter(Boolean);

  const relativeTime = formatRelativeTime(message.created_at);

  return (
    <div className="dm-answer-head">
      <span className="dm-answer-avatar">
        <AgentOrb size="small" />
      </span>
      <div className="dm-answer-head-copy">
        <div className="dm-message-identity">
          <strong>DocuMind</strong>
          {relativeTime ? <time dateTime={message.created_at}>{relativeTime}</time> : null}
        </div>
        {meta.length > 0 ? <p>{meta.join(" · ")}</p> : null}
      </div>
    </div>
  );
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
  onSubmitFeedback,
  onClearFeedback,
  onCitationClick,
  onFollowUp,
}: MessageRowProps) {
  const { me } = useAuth();
  const [copied, setCopied] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState<Rating | null>(
    message.feedback?.rating ?? null
  );
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [feedbackError, setFeedbackError] = useState("");
  const [downPanelOpen, setDownPanelOpen] = useState(false);
  const [downReason, setDownReason] = useState(message.feedback?.comment ?? "");

  const handleCopy = async () => {
    if (await copyToClipboard(message.content)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  useEffect(() => {
    setFeedbackRating(message.feedback?.rating ?? null);
    setDownReason(message.feedback?.comment ?? "");
    setDownPanelOpen(false);
    setFeedbackError("");
  }, [message.feedback?.comment, message.feedback?.rating, message.message_id]);

  const saveFeedback = async (
    rating: Rating,
    reason?: FeedbackReason,
    comment?: string
  ) => {
    if (feedbackSaving) return;
    const previous = feedbackRating;
    setFeedbackSaving(true);
    setFeedbackError("");
    setFeedbackRating(rating);
    const saved = await onSubmitFeedback(
      message.message_id,
      rating,
      reason,
      comment
    );
    if (saved) {
      setDownPanelOpen(false);
    } else {
      setFeedbackRating(previous);
      setFeedbackError("反馈提交失败，请重试");
    }
    setFeedbackSaving(false);
  };

  const clearFeedback = async () => {
    if (feedbackSaving) return;
    const previous = feedbackRating;
    setFeedbackSaving(true);
    setFeedbackError("");
    setFeedbackRating(null);
    const cleared = await onClearFeedback(message.message_id);
    if (cleared) {
      setDownPanelOpen(false);
      setDownReason("");
    } else {
      setFeedbackRating(previous);
      setFeedbackError("取消反馈失败，请重试");
    }
    setFeedbackSaving(false);
  };

  if (message.role === "user") {
    const userLabel = me?.user.name?.trim() || me?.user.email?.split("@")[0] || "你";
    const initials = userLabel.slice(0, 1).toUpperCase();
    const relativeTime = formatRelativeTime(message.created_at);
    return (
      <article className="dm-question-row">
        <span className="dm-user-message-avatar" aria-hidden="true">
          {me?.user.avatar_url ? <img alt="" src={me.user.avatar_url} /> : initials}
        </span>
        <div className="dm-user-message-stack">
          <div className="dm-user-message-meta">
            <strong>你</strong>
            {relativeTime ? <time dateTime={message.created_at}>{relativeTime}</time> : null}
          </div>
          <div className="dm-user-bubble">{message.content}</div>
          <div className="dm-user-message-actions">
            <IconButton aria-label="复制" onClick={handleCopy}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </IconButton>
          </div>
        </div>
      </article>
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
    <article
      className={`dm-answer-card ${isStreaming ? "streaming" : ""}`}
      data-feedback-rating={feedbackRating ?? "none"}
    >
      <AgentMeta
        message={{ ...message, citations: displayCitations }}
        hasCitations={hasDisplayCitations}
        deletedAll={deletedAll}
      />

      <ReasoningTrace
        steps={message.reasoning_steps}
        toolCalls={message.tool_calls}
        answerContent={message.content}
        isStreaming={isStreaming}
        durationMs={message.duration_ms}
        status={message.status}
      />

      {failed || cancelled ? (
        <div className="dm-answer-error">
          {cancelled ? "生成已取消" : message.content || "生成失败，请重试"}
        </div>
      ) : hasContent ? (
        <AnswerContent
          content={message.content}
          isStreaming={isStreaming}
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
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </IconButton>
        {!isStreaming ? (
          <>
            <IconButton
              aria-label={feedbackRating === "up" ? "取消点赞" : "点赞"}
              aria-pressed={feedbackRating === "up"}
              className={`dm-feedback-button is-up ${
                feedbackRating === "up" ? "is-active" : ""
              }`}
              disabled={feedbackSaving}
              onClick={() => {
                if (feedbackRating === "up") void clearFeedback();
                else void saveFeedback("up");
              }}
              title={feedbackRating === "up" ? "取消点赞" : "有帮助"}
            >
              <ThumbsUp
                fill={feedbackRating === "up" ? "currentColor" : "none"}
                size={13}
              />
            </IconButton>
            <IconButton
              aria-controls={`feedback-panel-${message.message_id}`}
              aria-expanded={downPanelOpen}
              aria-label={feedbackRating === "down" ? "取消点踩" : "点踩"}
              aria-pressed={feedbackRating === "down"}
              className={`dm-feedback-button is-down ${
                feedbackRating === "down" || downPanelOpen ? "is-active" : ""
              }`}
              disabled={feedbackSaving}
              onClick={() => {
                if (feedbackRating === "down") {
                  void clearFeedback();
                } else {
                  setDownPanelOpen((open) => !open);
                  setFeedbackError("");
                }
              }}
              title={feedbackRating === "down" ? "取消点踩" : "没有帮助"}
            >
              <ThumbsDown
                fill={feedbackRating === "down" ? "currentColor" : "none"}
                size={13}
              />
            </IconButton>
          </>
        ) : null}
        {isStreaming ? (
          <Button variant="secondary" onClick={onCancel}>
            停止
          </Button>
        ) : failed || cancelled ? (
          <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={onRetry}>
            重试
          </Button>
        ) : null}

        {downPanelOpen && !isStreaming ? (
          <form
            className="dm-feedback-panel"
            id={`feedback-panel-${message.message_id}`}
            onSubmit={(event) => {
              event.preventDefault();
              const comment = downReason.trim() || undefined;
              void saveFeedback("down", "not_helpful", comment);
            }}
          >
            <label htmlFor={`feedback-reason-${message.message_id}`}>
              这条回复哪里不对？
            </label>
            <textarea
              autoFocus
              id={`feedback-reason-${message.message_id}`}
              onChange={(event) => setDownReason(event.target.value)}
              placeholder="可以简单说下原因"
              rows={3}
              value={downReason}
            />
            {feedbackError ? (
              <p className="dm-feedback-error" role="alert">
                {feedbackError}
              </p>
            ) : null}
            <div className="dm-feedback-panel-actions">
              <button
                onClick={() => {
                  setDownPanelOpen(false);
                  setFeedbackError("");
                }}
                type="button"
              >
                取消
              </button>
              <button disabled={feedbackSaving} type="submit">
                {feedbackSaving ? "提交中…" : "提交"}
              </button>
            </div>
          </form>
        ) : null}
        {feedbackError && !downPanelOpen ? (
          <span className="dm-feedback-error is-inline" role="alert">
            {feedbackError}
          </span>
        ) : null}
      </div>
    </article>
  );
}
