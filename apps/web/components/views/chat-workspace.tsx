"use client";

import { useState } from "react";
import {
  ArrowUp,
  Bot,
  Check,
  Copy,
  History,
  MapPin,
  PanelRightClose,
  PanelRightOpen,
  Settings,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { StatCard } from "@/components/ui/stat-card";
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
    loading,
    streamingId,
    stages,
    rightOpen,
    setRightOpen,
    sendMessage,
    retryMessage,
    cancelMessage,
    submitFeedback,
  } = useConversation();
  const [input, setInput] = useState("");
  const [feedbackMessageId, setFeedbackMessageId] = useState<string | null>(null);
  const [feedbackReason, setFeedbackReason] = useState<FeedbackReason | undefined>();
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackCorrection, setFeedbackCorrection] = useState("");
  const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null);

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    await sendMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const latestAssistant = messages.filter((m) => m.role === "assistant").pop();
  const sourceDocs = latestAssistant?.citations ?? [];

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
          onCitationClick={(c) => setSelectedCitation(c)}
        />
      ))}

      {messages.length > 0 && (
        <div className="dm-process-card">
          {stages.map((stage) => (
            <div className="dm-stage" key={stage.label}>
              <span className={`dm-stage-dot ${stage.done ? "done" : stage.running ? "running" : ""}`}>
                {stage.done ? <Check size={16} /> : null}
              </span>
              <span>{stage.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

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
            onClick={() => {
              setInput(text);
            }}
            type="button"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );

  const renderRightRail = () => {
    if (!rightOpen) {
      return (
        <div className="dm-right-rail-collapsed">
          <IconButton aria-label="展开检索详情" onClick={() => setRightOpen(true)}>
            <PanelRightOpen size={16} />
          </IconButton>
          <div className="dm-rail-dots">
            {stages.map((_, i) => (
              <span key={i} />
            ))}
          </div>
        </div>
      );
    }

    return (
      <aside className="dm-right-rail">
        <div className="dm-right-rail-head">
          <h3>检索详情</h3>
          <IconButton aria-label="收起" onClick={() => setRightOpen(false)}>
            <PanelRightClose size={16} />
          </IconButton>
        </div>

        <div className="dm-rail-section">
          <div className="dm-rail-section-head">
            <span className="dm-rail-section-title">查询进度</span>
          </div>
          {stages.map((stage, i) => (
            <div className="dm-rail-progress-row" key={stage.label}>
              <span className="dm-rail-step-number">{i + 1}</span>
              <span>{stage.label}</span>
              {stage.done ? <Check className="check" size={14} /> : null}
            </div>
          ))}
        </div>

        <div className="dm-rail-section">
          <div className="dm-rail-section-head">
            <span className="dm-rail-section-title">来源文档</span>
            <span className="dm-rail-section-hint">{sourceDocs.length} 个来源</span>
          </div>
          {sourceDocs.map((doc) => (
            <div className="dm-rail-doc-card" key={doc.index}>
              <div className="dm-rail-doc-card-head">
                <strong>[{doc.index}] {doc.doc_title}</strong>
              </div>
              <span className="page">
                第 {doc.page_range.join("-")} 页 · 切片 {doc.chunk_id.slice(0, 8)}
              </span>
              <p>{doc.quote}</p>
            </div>
          ))}
        </div>
      </aside>
    );
  };

  return (
    <>
      <header className="dm-chat-topbar">
        <span className="dm-chat-topbar-title">产品文档库</span>
        <div className="dm-chat-topbar-actions">
          <IconButton aria-label="历史" onClick={() => setRightOpen(false)}>
            <History size={16} />
          </IconButton>
          <IconButton aria-label="检索详情" onClick={() => setRightOpen((v) => !v)}>
            <Settings size={16} />
          </IconButton>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div className="dm-chat-main">
          {messages.length === 0 && !loading ? renderEmpty() : renderStream()}

          <div className="dm-composer">
            <div className="dm-composer-box">
              <input
                placeholder="向产品文档库提问..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={!!streamingId}
              />
              <button
                className="dm-send-button"
                aria-label="发送"
                onClick={handleSend}
                disabled={!input.trim() || !!streamingId}
              >
                <ArrowUp size={16} />
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

      {selectedCitation && (
        <div className="dm-drawer-overlay" onClick={() => setSelectedCitation(null)}>
          <aside className="dm-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="dm-drawer-head">
              <div className="dm-drawer-head-row">
                <h2>引用预览</h2>
                <IconButton onClick={() => setSelectedCitation(null)} aria-label="关闭">
                  <X size={18} />
                </IconButton>
              </div>
              <div className="dm-drawer-meta">
                <span style={{ color: "var(--text-primary)", fontSize: 14, fontWeight: 600 }}>
                  [{selectedCitation.index}] {selectedCitation.doc_title}
                </span>
              </div>
              <p style={{ marginTop: 4 }}>
                第 {selectedCitation.page_range.join("-")} 页 · 切片{" "}
                {selectedCitation.chunk_id.slice(0, 8)}
              </p>
            </div>

            <div className="dm-citation-quote-block">
              <strong>引用原文</strong>
              <p>{selectedCitation.quote}</p>
            </div>

            <div style={{ flex: 1 }} />

            <div className="dm-drawer-footer">
              <Button variant="secondary" onClick={() => setSelectedCitation(null)}>
                关闭
              </Button>
              <Button icon={<MapPin size={14} />}>定位到该页</Button>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

function MessageRow({
  message,
  isStreaming,
  onRetry,
  onCancel,
  onFeedback,
  onCitationClick,
}: {
  message: Message;
  isStreaming: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onFeedback: (id: string) => void;
  onCitationClick: (c: Citation) => void;
}) {
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

  return (
    <article className={`dm-answer-card ${isStreaming ? "streaming" : ""}`}>
      <div className="dm-answer-head">
        <span className="dm-answer-avatar">
          <Bot size={14} />
        </span>
        <div>
          <strong>DocuMind</strong>
          <p>
            {message.citations.length > 0
              ? `基于 ${message.citations.length} 个来源`
              : "未找到相关来源"}
            {message.confidence ? ` · 置信度 ${confidenceLabel(message.confidence)}` : ""}
          </p>
        </div>
      </div>

      <p>{message.content || (isStreaming ? "思考中..." : "")}</p>

      {message.citations.length > 0 && (
        <div className="dm-citation-grid">
          {message.citations.map((citation) => (
            <div
              className="dm-citation-card"
              key={citation.index}
              onClick={() => onCitationClick(citation)}
              role="button"
              tabIndex={0}
            >
              <strong>
                [{citation.index}] {citation.doc_title}
              </strong>
              <p>{citation.quote}</p>
              <span>第 {citation.page_range.join("-")} 页</span>
            </div>
          ))}
        </div>
      )}

      <div className="dm-answer-actions">
        <IconButton aria-label="赞" onClick={() => onFeedback(message.message_id)}>
          <ThumbsUp size={16} />
        </IconButton>
        <IconButton aria-label="踩" onClick={() => onFeedback(message.message_id)}>
          <ThumbsDown size={16} />
        </IconButton>
        <IconButton aria-label="复制" onClick={handleCopy}>
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </IconButton>
        {message.status === "answering" && isStreaming ? (
          <Button variant="secondary" onClick={onCancel}>
            停止
          </Button>
        ) : message.status === "failed" || message.status === "cancelled" ? (
          <Button variant="secondary" onClick={onRetry}>
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
