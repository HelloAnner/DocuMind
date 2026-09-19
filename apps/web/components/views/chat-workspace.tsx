"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bookmark,
  Brain,
  BookOpen,
  Check,
  ChevronUp,
  Folder,
  Menu,
  MessageSquareText,
  Search,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { MessageRow } from "@/components/chat/message-row";
import {
  previewTargetFromCitation,
  type DocumentPreviewTarget,
} from "@/components/chat/document-preview";
import { ConversationFilesPanel } from "@/components/chat/conversation-files-panel";
import { useConversation } from "@/components/providers/conversation-provider";
import type { Citation, Message } from "@/lib/types";
import { useChatShell } from "@/components/providers/chat-shell-provider";
import { AgentOrb } from "@/components/ui/brand-mark";
import { useAuth } from "@/components/providers/auth-provider";
import { getChatModels, type ChatModelOption } from "@/lib/api";

const suggestions = [
  "Q3 采购合同的付款节点是什么？",
  "员工报销需要哪些材料？",
  "华东区 Q3 销售目标是多少？",
];

function thinkingLabel(mode: ChatModelOption["thinking_mode"]) {
  if (mode === "always_on") return "始终深度思考";
  if (mode === "switchable") return "快速 / 深度思考";
  return "快速模式";
}

function ModelPicker({
  models,
  value,
  disabled,
  onChange,
}: {
  models: ChatModelOption[];
  value: string;
  disabled: boolean;
  onChange: (model: ChatModelOption) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [previewId, setPreviewId] = useState(value);
  const selected = models.find((model) => model.id === value);
  const preview = models.find((model) => model.id === previewId) ?? selected;
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(needle))
    : models;

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="chat-model-picker" ref={rootRef}>
      <button
        type="button"
        className="chat-model-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled || models.length === 0}
        onClick={() => {
          setPreviewId(value);
          setQuery("");
          setOpen((current) => !current);
        }}
      >
        <span>{selected?.name ?? "选择模型"}</span>
        <ChevronUp size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="chat-model-menu" role="dialog" aria-label="选择对话模型">
          <div className="chat-model-list-panel">
            <label className="chat-model-search">
              <Search size={15} aria-hidden="true" />
              <span className="sr-only">搜索模型</span>
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索模型"
              />
            </label>
            <div className="chat-model-section-label">官方推荐</div>
            <div className="chat-model-options" role="listbox">
              {filtered.map((model) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={model.id === value}
                  className={`chat-model-option${model.id === value ? " selected" : ""}`}
                  key={model.id}
                  onMouseEnter={() => setPreviewId(model.id)}
                  onFocus={() => setPreviewId(model.id)}
                  onClick={() => {
                    onChange(model);
                    setOpen(false);
                  }}
                >
                  <strong>{model.name}</strong>
                  <span className="chat-model-option-tail">
                    <small>{model.thinking_mode === "always_on" ? "深度" : model.thinking_mode === "switchable" ? "灵活" : "快速"}</small>
                    {model.id === value ? <Check size={14} aria-hidden="true" /> : null}
                  </span>
                </button>
              ))}
              {filtered.length === 0 ? <p className="chat-model-empty">没有匹配的模型</p> : null}
            </div>
          </div>
          {preview ? (
            <aside className="chat-model-detail">
              <div className="chat-model-detail-title">
                <strong>{preview.name}</strong>
                <span>{preview.thinking_mode === "always_on" ? "深度" : preview.thinking_mode === "switchable" ? "灵活" : "快速"}</span>
              </div>
              <p>{preview.id}</p>
              <div className="chat-model-capability">
                <span>思考能力</span>
                <strong>{thinkingLabel(preview.thinking_mode)}</strong>
              </div>
              <code>{preview.id}</code>
            </aside>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function timeGreeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

export function ChatWorkspace() {
  const { openMobile } = useChatShell();
  const { me } = useAuth();
  const {
    messages,
    conversations,
    loading,
    streamingId,
    rightOpen,
    setRightOpen,
    currentId,
    availableKbs,
    sendMessage,
    retryMessage,
    cancelMessage,
    submitFeedback,
    clearFeedback,
    isFavorite,
    toggleFavorite,
  } = useConversation();

  const [input, setInput] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const previousMessageCountRef = useRef(0);
  const followStreamRef = useRef(true);
  const [previewTarget, setPreviewTarget] = useState<DocumentPreviewTarget | null>(null);
  const [chatModels, setChatModels] = useState<ChatModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [thinkingEnabled, setThinkingEnabled] = useState(false);

  const currentConversation = conversations.find((c) => c.conversation_id === currentId);
  const currentFavorite = currentId ? isFavorite(currentId) : false;
  const userName = me?.user.name?.trim() || me?.user.email?.split("@")[0] || "你";
  const filesRefreshKey = messages
    .map((message) => `${message.message_id}:${message.status}:${message.citations.length}`)
    .join("|");

  const selectedModelOption = chatModels.find((model) => model.id === selectedModel);
  const runtimeOptions = {
    model_id: selectedModel || undefined,
    thinking_enabled: selectedModelOption?.thinking_mode === "always_on"
      ? true
      : thinkingEnabled,
  };

  useEffect(() => {
    let active = true;
    getChatModels().then((catalog) => {
      if (!active) return;
      setChatModels(catalog.models);
      setSelectedModel(catalog.default_model_id);
      setThinkingEnabled(
        catalog.models.find((model) => model.id === catalog.default_model_id)?.thinking_default
          ?? false
      );
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setPreviewTarget(null);
  }, [currentId]);

  useEffect(() => {
    if (loading || messages.length === 0) return;
    followStreamRef.current = true;
    const frame = requestAnimationFrame(() => {
      streamEndRef.current?.scrollIntoView({ block: "end" });
      setShowScrollToBottom(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [currentId, loading]);

  useEffect(() => {
    const previousCount = previousMessageCountRef.current;
    previousMessageCountRef.current = messages.length;
    if (messages.length === 0) {
      setShowScrollToBottom(false);
      return;
    }
    if (messages.length <= previousCount || previousCount === 0) return;

    followStreamRef.current = true;
    const frame = requestAnimationFrame(() => {
      const container = streamRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
        setShowScrollToBottom(false);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [messages.length]);

  useEffect(() => {
    if (!streamingId || !followStreamRef.current) return;
    const frame = requestAnimationFrame(() => {
      const container = streamRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, streamingId]);

  const scrollToBottom = () => {
    followStreamRef.current = true;
    streamEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  const handleStreamScroll = () => {
    const container = streamRef.current;
    if (!container) return;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    followStreamRef.current = distance <= 100;
    setShowScrollToBottom(distance > 100);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    await sendMessage(text, runtimeOptions);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCitationClick = (c: Citation) => {
    setPreviewTarget(previewTargetFromCitation(c));
    setRightOpen(true);
  };

  const renderEmpty = () => (
    <div className="dm-chat-empty">
      <div className="dm-chat-empty-orb-wrap">
        <AgentOrb size="large" />
      </div>
      <span className="dm-chat-empty-eyebrow">企业知识智能体</span>
      <p className="dm-chat-empty-greeting">{timeGreeting()}，{userName}</p>
      <h2>今天想从知识中找到什么？</h2>
      <p className="dm-chat-empty-description">从企业文档中检索事实、理解上下文，并保留每一处原文依据。</p>
      <div className="dm-chat-capabilities" aria-label="问答能力">
        <span className="active">知识问答</span>
        <span>引用定位</span>
        <span>跨库检索</span>
      </div>
      <div className="dm-chat-empty-suggestions">
        {suggestions.map((text) => (
          <button key={text} onClick={() => setInput(text)} type="button">
            <span>{text}</span>
            <ArrowUpRight size={13} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );

  const renderStream = () => (
    <div className="dm-chat-stream" ref={streamRef} onScroll={handleStreamScroll}>
      {messages.map((message) => (
        <div
          className="dm-message-entry"
          data-message-id={message.message_id}
          data-role={message.role}
          key={message.message_id}
        >
          <MessageRow
            message={message}
            isStreaming={message.message_id === streamingId}
            onRetry={() => retryMessage(message.message_id)}
            onSubmitFeedback={submitFeedback}
            onClearFeedback={clearFeedback}
            onCitationClick={handleCitationClick}
            onFollowUp={(text) => sendMessage(text, runtimeOptions)}
          />
        </div>
      ))}
      <div className="dm-chat-stream-end" ref={streamEndRef} />
    </div>
  );

  return (
    <>
      <div className={`dm-chat-workspace ${rightOpen ? "has-right-rail" : ""}`}>
        <div className="dm-chat-main">
          <div className="dm-chat-session-header">
            <div className="dm-chat-session-title">
              <IconButton aria-label="打开会话导航" className="dm-chat-mobile-menu" onClick={openMobile}>
                <Menu size={18} />
              </IconButton>
              <span className="dm-chat-agent-name">DocuMind</span>
              <span className="dm-chat-title-separator" aria-hidden="true">/</span>
              <MessageSquareText className="dm-chat-title-icon" size={14} aria-hidden="true" />
              <strong>{currentConversation?.title ?? "新会话"}</strong>
              <IconButton
                aria-label={currentFavorite ? "取消收藏会话" : "收藏会话"}
                aria-pressed={currentFavorite}
                className={`dm-chat-title-bookmark ${currentFavorite ? "active" : ""}`}
                disabled={!currentId}
                onClick={() => currentId && toggleFavorite(currentId)}
              >
                <Bookmark size={16} fill={currentFavorite ? "currentColor" : "none"} />
              </IconButton>
            </div>
            <div className="dm-chat-session-actions">
              <IconButton
                aria-label={rightOpen ? "关闭会话文件" : "打开会话文件"}
                className={`dm-file-preview-toggle ${rightOpen ? "active" : ""}`}
                onClick={() => {
                  if (rightOpen) {
                    setRightOpen(false);
                  } else {
                    setPreviewTarget(null);
                    setRightOpen(true);
                  }
                }}
              >
                <Folder size={19} />
              </IconButton>
            </div>
          </div>

          {messages.length === 0 && !loading ? renderEmpty() : renderStream()}

          {showScrollToBottom ? (
            <button className="dm-scroll-to-bottom" onClick={scrollToBottom} type="button" aria-label="滚动到底部">
              <ArrowDown size={13} />
            </button>
          ) : null}

          <div className="dm-composer">
            <div className="dm-composer-box">
              <div className="dm-composer-input-row">
                <textarea
                  aria-label="消息输入框"
                  placeholder="描述你的需求，或 @ 引用文件"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onCompositionStart={() => setIsComposing(true)}
                  onCompositionEnd={() => setIsComposing(false)}
                  rows={1}
                />
              </div>
              <div className="dm-composer-toolbar">
                <div className="dm-composer-tools">
                  <span
                    className="dm-composer-context"
                    title="本次问答覆盖当前有权访问的知识库"
                    aria-label={`本次问答覆盖${availableKbs.length > 0 ? `${availableKbs.length} 个` : "当前有权访问的"}知识库`}
                  >
                    <BookOpen size={14} aria-hidden="true" />
                    <span className="dm-composer-context-label">
                      {availableKbs.length > 0 ? `${availableKbs.length} 个知识库` : "知识库问答"}
                    </span>
                  </span>
                  {chatModels.length > 0 ? (
                    <>
                      <ModelPicker
                        models={chatModels}
                        value={selectedModel}
                        disabled={!!streamingId}
                        onChange={(model) => {
                          setSelectedModel(model.id);
                          setThinkingEnabled(model.thinking_default);
                        }}
                      />
                      <label
                        className={`dm-thinking-toggle ${thinkingEnabled ? "active" : ""}`}
                        title="开启后实时显示灰色思考文字，正文开始时自动消失"
                      >
                        <Brain size={13} aria-hidden="true" />
                        <span>深度思考</span>
                        <input
                          type="checkbox"
                          checked={selectedModelOption?.thinking_mode === "always_on" || thinkingEnabled}
                          disabled={
                            !!streamingId ||
                            selectedModelOption?.thinking_mode === "always_on" ||
                            selectedModelOption?.thinking_mode === "unsupported"
                          }
                          onChange={(event) => setThinkingEnabled(event.target.checked)}
                        />
                      </label>
                    </>
                  ) : null}
                </div>
                <button
                  className={`dm-send-button ${streamingId ? "running" : ""}`}
                  aria-label={streamingId ? "停止" : "发送"}
                  onClick={streamingId ? () => streamingId && cancelMessage(streamingId) : handleSend}
                  disabled={!streamingId && !input.trim()}
                >
                  {streamingId ? <Square size={14} fill="currentColor" /> : <ArrowUp size={18} />}
                </button>
              </div>
            </div>
          </div>
          <div className="dm-chat-footer-note">内容由 AI 生成，请仔细甄别</div>
        </div>

        <ConversationFilesPanel
          conversationId={currentId}
          open={rightOpen}
          previewTarget={previewTarget}
          refreshKey={filesRefreshKey}
          onPreviewTargetChange={setPreviewTarget}
          onClose={() => setRightOpen(false)}
        />
      </div>

    </>
  );
}
