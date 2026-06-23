"use client";

import { useState } from "react";
import { Bot, Check, Copy, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { CitationCard, isCitationDeleted } from "./citation-card";
import { AnswerContent } from "./answer-content";
import type { Citation, Message } from "@/lib/types";

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

interface MessageRowProps {
  message: Message;
  isStreaming: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onFeedback: (id: string) => void;
  onCitationClick: (c: Citation) => void;
}

function StreamingIndicator() {
  return (
    <div className="dm-streaming-indicator">
      <span>正在检索相关文档</span>
      <span className="dm-streaming-dots">
        <span />
        <span />
        <span />
      </span>
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
  const failed = message.status === "failed";
  const cancelled = message.status === "cancelled";
  const deletedAll = hasCitations && message.citations.every(isCitationDeleted);

  return (
    <article className={`dm-answer-card ${isStreaming ? "streaming" : ""}`}>
      <div className="dm-answer-head">
        <span className="dm-answer-avatar">
          <Bot size={14} />
        </span>
        <div>
          <strong>DocuMind</strong>
          <p>
            {hasCitations
              ? `基于 ${message.citations.length} 个来源`
              : "未找到相关来源"}
            {message.confidence ? ` · 置信度 ${confidenceLabel(message.confidence)}` : ""}
            {deletedAll ? " · 来源已删除" : ""}
          </p>
        </div>
      </div>

      {failed || cancelled ? (
        <div className="dm-answer-error">
          {cancelled ? "生成已取消" : message.content || "生成失败，请重试"}
        </div>
      ) : isStreaming && !message.content ? (
        <StreamingIndicator />
      ) : (
        <AnswerContent
          content={message.content}
          citations={message.citations}
          onCitationClick={(idx) => {
            const c = message.citations.find((c) => c.index === idx);
            if (c) onCitationClick(c);
          }}
        />
      )}

      {hasCitations && !isStreaming && (
        <div className="dm-answer-citations">
          <div className="dm-answer-citations-row">
            {message.citations.map((citation) => (
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
