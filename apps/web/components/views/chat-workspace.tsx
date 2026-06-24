"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  ChevronUp,
  ChevronDown,
  Plus,
  PanelRightClose,
  PanelRightOpen,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { StatCard } from "@/components/ui/stat-card";
import { MessageRow } from "@/components/chat/message-row";
import { CitationCard } from "@/components/chat/citation-card";
import { DocumentPreview } from "@/components/chat/document-preview";
import { useConversation } from "@/components/providers/conversation-provider";
import type { Citation, FeedbackReason, Message, Rating } from "@/lib/types";

const suggestions = [
  "Q3 采购合同的付款节点是什么？",
  "员工报销需要哪些材料？",
  "华东区 Q3 销售目标是多少？",
];

export function ChatWorkspace() {
  const {
    messages,
    conversations,
    loading,
    streamingId,
    stages,
    rightOpen,
    setRightOpen,
    currentId,
    sendMessage,
    retryMessage,
    cancelMessage,
    submitFeedback,
  } = useConversation();

  const [input, setInput] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [feedbackMessageId, setFeedbackMessageId] = useState<string | null>(null);
  const [feedbackReason, setFeedbackReason] = useState<FeedbackReason | undefined>();
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackCorrection, setFeedbackCorrection] = useState("");
  const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null);

  const latestAssistant = messages.filter((m) => m.role === "assistant").pop();
  const sourceDocs = latestAssistant?.citations ?? [];
  const currentConversation = conversations.find((c) => c.conversation_id === currentId);

  const currentSourceIndex = selectedCitation
    ? sourceDocs.findIndex((c) => c.index === selectedCitation.index)
    : -1;

  const navigateCitation = (dir: -1 | 1) => {
    if (sourceDocs.length === 0) return;
    const idx =
      currentSourceIndex === -1
        ? dir === 1
          ? 0
          : sourceDocs.length - 1
        : (currentSourceIndex + dir + sourceDocs.length) % sourceDocs.length;
    setSelectedCitation(sourceDocs[idx]);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    await sendMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCitationClick = (c: Citation) => {
    setSelectedCitation(c);
    setRightOpen(true);
  };

  const renderEmpty = () => (
    <div className="dm-chat-empty">
      <span className="dm-chat-empty-avatar">
        <Bot size={24} />
      </span>
      <h2>向你的文档提问</h2>
      <p>选择知识库，输入问题，获取带原文出处的精准答案</p>
      <div className="dm-chat-empty-stats">
        <StatCard label="文档数" value="128" hint="已索引" />
        <StatCard label="切片数" value="4,832" hint="可用" />
      </div>
      <div className="dm-chat-empty-suggestions">
        {suggestions.map((text) => (
          <button
            key={text}
            onClick={() => setInput(text)}
            type="button"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );

  const renderStream = () => (
    <div className="dm-chat-stream">
      {messages.map((message) => (
        <MessageRow
          key={message.message_id}
          message={message}
          isStreaming={message.message_id === streamingId}
          onRetry={() => retryMessage(message.message_id)}
          onCancel={() => cancelMessage(message.message_id)}
          onFeedback={(id) => setFeedbackMessageId(id)}
          onCitationClick={handleCitationClick}
          stages={
            message.message_id === streamingId ||
            (message.role === "assistant" && message.message_id === latestAssistant?.message_id)
              ? stages
              : undefined
          }
        />
      ))}
    </div>
  );

  const renderRightRail = () => {
    if (!rightOpen) {
      return (
        <div className="dm-right-rail-collapsed">
          <IconButton aria-label="展开引用来源" onClick={() => setRightOpen(true)}>
            <PanelRightOpen size={16} />
          </IconButton>
          <div className="dm-rail-dots">
            {sourceDocs.slice(0, 4).map((_, i) => (
              <span key={i} />
            ))}
          </div>
        </div>
      );
    }

    return (
      <aside className="dm-right-rail">
        <div className="dm-right-rail-head">
          <h3>文档预览</h3>
          <div className="dm-right-rail-head-actions">
            <IconButton
              aria-label="上一条"
              onClick={() => navigateCitation(-1)}
              disabled={sourceDocs.length === 0}
            >
              <ChevronUp size={16} />
            </IconButton>
            <span className="dm-right-rail-paging">
              {sourceDocs.length > 0
                ? `${currentSourceIndex >= 0 ? currentSourceIndex + 1 : 1} / ${sourceDocs.length}`
                : "- / -"}
            </span>
            <IconButton
              aria-label="下一条"
              onClick={() => navigateCitation(1)}
              disabled={sourceDocs.length === 0}
            >
              <ChevronDown size={16} />
            </IconButton>
            <IconButton aria-label="收起" onClick={() => setRightOpen(false)}>
              <PanelRightClose size={16} />
            </IconButton>
          </div>
        </div>

        <div className="dm-right-rail-body">
          <div className="dm-rail-section dm-rail-source-section">
            <div className="dm-rail-section-head">
              <span className="dm-rail-section-title">来源文档</span>
              <span className="dm-rail-section-hint">{sourceDocs.length} 个来源</span>
            </div>
            {sourceDocs.length === 0 ? (
              <p className="dm-rail-empty">完成回答后显示引用来源</p>
            ) : (
              <div className="dm-rail-source-list">
                {sourceDocs.map((doc) => (
                  <CitationCard
                    key={doc.index}
                    citation={doc}
                    active={selectedCitation?.index === doc.index}
                    onClick={handleCitationClick}
                  />
                ))}
              </div>
            )}
          </div>

          {selectedCitation && (
            <div className="dm-rail-section dm-rail-preview-section">
              <DocumentPreview citation={selectedCitation} />
            </div>
          )}
        </div>
      </aside>
    );
  };

  return (
    <>
      <div className="dm-chat-workspace">
        <div className="dm-chat-main">
          <div className="dm-chat-session-header">
            <div className="dm-chat-session-title">
              <strong>{currentConversation?.title ?? "新会话"}</strong>
              <span>DocuMind Agent · 知识库问答</span>
            </div>
            <div className="dm-chat-session-actions">
              <IconButton
                aria-label={rightOpen ? "收起引用来源" : "展开引用来源"}
                onClick={() => setRightOpen(!rightOpen)}
              >
                {rightOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
              </IconButton>
            </div>
          </div>

          {messages.length === 0 && !loading ? renderEmpty() : renderStream()}

          <div className="dm-composer">
            <div className="dm-composer-box">
              <button type="button" className="dm-composer-tool" aria-label="添加附件">
                <Plus size={17} />
              </button>
              <textarea
                ref={textareaRef}
                placeholder={streamingId ? "DocuMind 正在处理…" : "输入问题，Shift + Enter 换行"}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onInput={(e) => {
                  e.currentTarget.style.height = "auto";
                  e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 180)}px`;
                }}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => setIsComposing(true)}
                onCompositionEnd={() => setIsComposing(false)}
                disabled={!!streamingId}
                rows={1}
              />
              <button
                className={`dm-send-button ${streamingId ? "running" : ""}`}
                aria-label={streamingId ? "停止" : "发送"}
                onClick={streamingId ? () => streamingId && cancelMessage(streamingId) : handleSend}
                disabled={!streamingId && !input.trim()}
              >
                {streamingId ? <Square size={14} fill="currentColor" /> : <ArrowUp size={16} />}
              </button>
            </div>
          </div>
        </div>

        {renderRightRail()}
      </div>

      {feedbackMessageId && (
        <FeedbackDrawer
          onClose={() => setFeedbackMessageId(null)}
          onSubmit={async (rating, reason, comment, correction) => {
            await submitFeedback(feedbackMessageId, rating, reason, comment, correction);
            setFeedbackMessageId(null);
            setFeedbackReason(undefined);
            setFeedbackComment("");
            setFeedbackCorrection("");
          }}
          reason={feedbackReason}
          setReason={setFeedbackReason}
          comment={feedbackComment}
          setComment={setFeedbackComment}
          correction={feedbackCorrection}
          setCorrection={setFeedbackCorrection}
        />
      )}
    </>
  );
}

function FeedbackDrawer({
  onClose,
  onSubmit,
  reason,
  setReason,
  comment,
  setComment,
  correction,
  setCorrection,
}: {
  onClose: () => void;
  onSubmit: (rating: Rating, reason?: FeedbackReason, comment?: string, correction?: string) => void;
  reason?: FeedbackReason;
  setReason: (r?: FeedbackReason) => void;
  comment: string;
  setComment: (s: string) => void;
  correction: string;
  setCorrection: (s: string) => void;
}) {
  const [rating, setRating] = useState<Rating | null>(null);
  const reasons: { value: FeedbackReason; label: string }[] = [
    { value: "wrong_answer", label: "答案错误" },
    { value: "missing_source", label: "缺少引用" },
    { value: "outdated", label: "内容过期" },
    { value: "not_helpful", label: "没有帮助" },
    { value: "other", label: "其他" },
  ];

  return (
    <div className="dm-drawer-overlay" onClick={onClose}>
      <aside className="dm-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="dm-drawer-head">
          <div className="dm-drawer-head-row">
            <h2>提交反馈</h2>
            <IconButton onClick={onClose} aria-label="关闭">
              <X size={18} />
            </IconButton>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "0 20px 20px" }}>
          <div style={{ display: "flex", gap: 12 }}>
            <Button variant={rating === "up" ? "primary" : "secondary"} onClick={() => setRating("up")}>
              <ThumbsUp size={14} /> 有帮助
            </Button>
            <Button variant={rating === "down" ? "primary" : "secondary"} onClick={() => setRating("down")}>
              <ThumbsDown size={14} /> 没有帮助
            </Button>
          </div>

          {rating === "down" && (
            <>
              <label style={{ fontSize: 12, color: "var(--text-muted)" }}>原因</label>
              <select
                value={reason ?? ""}
                onChange={(e) => setReason((e.target.value as FeedbackReason) || undefined)}
                style={{
                  background: "var(--bg-tertiary)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 8,
                  padding: "8px 10px",
                }}
              >
                <option value="">请选择</option>
                {reasons.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>

              <label style={{ fontSize: 12, color: "var(--text-muted)" }}>补充说明</label>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                style={{
                  background: "var(--bg-tertiary)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 8,
                  padding: 10,
                  resize: "none",
                }}
              />

              <label style={{ fontSize: 12, color: "var(--text-muted)" }}>修正答案</label>
              <textarea
                value={correction}
                onChange={(e) => setCorrection(e.target.value)}
                rows={3}
                style={{
                  background: "var(--bg-tertiary)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 8,
                  padding: 10,
                  resize: "none",
                }}
              />
            </>
          )}

          <Button
            variant="primary"
            onClick={() => {
              if (!rating) return;
              onSubmit(rating, reason, comment || undefined, correction || undefined);
            }}
            disabled={!rating}
          >
            提交反馈
          </Button>
        </div>
      </aside>
    </div>
  );
}
