"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bookmark,
  BookOpen,
  Brain,
  Check,
  ChevronUp,
  Folder,
  Menu,
  MessageSquareText,
  Share2,
  Sparkles,
  Square,
  Zap,
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
import { createConversationShare, getChatModels, type ChatModelOption, type KnowledgeBase } from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";

const suggestions = [
  "Q3 采购合同的付款节点是什么？",
  "员工报销需要哪些材料？",
  "华东区 Q3 销售目标是多少？",
];

type ThinkingMode = "auto" | "deep" | "fast";

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
  const selected = models.find((model) => model.id === value);

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
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || models.length === 0}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.name ?? "选择模型"}</span>
        <ChevronUp size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="chat-model-menu" role="listbox" aria-label="选择对话模型">
          {models.map((model) => (
            <button
              type="button"
              role="option"
              aria-selected={model.id === value}
              className={`chat-model-option${model.id === value ? " selected" : ""}`}
              key={model.id}
              onClick={() => {
                onChange(model);
                setOpen(false);
              }}
            >
              <strong>{model.name}</strong>
              {model.id === value ? <Check size={14} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ThinkingModePicker({
  mode,
  model,
  disabled,
  onChange,
}: {
  mode: ThinkingMode;
  model?: ChatModelOption;
  disabled: boolean;
  onChange: (mode: ThinkingMode) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const options = [
    { value: "auto" as const, label: "自动", description: "由模型自行判断是否需要深度思考", icon: Sparkles },
    { value: "deep" as const, label: "深度思考", description: "强制启用深度思考，推理更准确", icon: Brain },
    { value: "fast" as const, label: "快速", description: "跳过深度思考，响应更快", icon: Zap },
  ];
  const ActiveIcon = mode === "deep" ? Brain : mode === "fast" ? Zap : Sparkles;

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
    <div className="chat-thinking-picker" ref={rootRef}>
      <button
        type="button"
        className={`chat-thinking-trigger mode-${mode}`}
        aria-label={`思考模式：${options.find((option) => option.value === mode)?.label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled || !model}
        onClick={() => setOpen((current) => !current)}
      >
        <ActiveIcon size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div className="chat-thinking-menu" role="dialog" aria-label="选择思考模式">
          {options.map((option) => {
            const Icon = option.icon;
            const unavailable =
              (option.value === "deep" && model?.thinking_mode === "unsupported") ||
              (option.value === "fast" && model?.thinking_mode === "always_on");
            return (
              <button
                type="button"
                className={`chat-thinking-option mode-${option.value}`}
                aria-pressed={mode === option.value}
                disabled={unavailable}
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <Icon size={19} aria-hidden="true" />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                <i aria-hidden="true" />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function KnowledgeBasePicker({
  knowledgeBases,
  value,
  disabled,
  error,
  onChange,
}: {
  knowledgeBases: KnowledgeBase[];
  value: string[];
  disabled: boolean;
  error?: string;
  onChange: (kbIds: string[]) => Promise<boolean>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const allSelected = knowledgeBases.length > 0
    && knowledgeBases.every((kb) => value.includes(kb.id));

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

  const toggle = (kbId: string) => {
    const next = value.includes(kbId)
      ? value.filter((id) => id !== kbId)
      : [...value, kbId];
    if (next.length > 0) void onChange(next);
  };

  return (
    <div className="chat-kb-picker" ref={rootRef}>
      <button
        type="button"
        className="chat-kb-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled || knowledgeBases.length === 0}
        onClick={() => setOpen((current) => !current)}
      >
        <BookOpen size={14} aria-hidden="true" />
        <span>
          {knowledgeBases.length === 0
            ? "暂无知识库"
            : allSelected
              ? `全部知识库 · ${knowledgeBases.length}`
              : `${value.length} 个知识库`}
        </span>
        <ChevronUp size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="chat-kb-menu" role="dialog" aria-label="选择本对话使用的知识库">
          <div className="chat-kb-menu-heading">
            <div>
              <strong>检索范围</strong>
              <span>为当前对话独立保存</span>
            </div>
            <span className="chat-kb-count">{value.length}/{knowledgeBases.length}</span>
          </div>
          <button
            type="button"
            className={`chat-kb-all${allSelected ? " selected" : ""}`}
            role="checkbox"
            aria-checked={allSelected}
            disabled={disabled}
            onClick={() => void onChange(knowledgeBases.map((kb) => kb.id))}
          >
            <span className="chat-kb-check">{allSelected ? <Check size={13} /> : null}</span>
            <span>
              <strong>全部知识库</strong>
              <small>跨库检索所有当前可访问内容</small>
            </span>
          </button>
          <div className="chat-kb-section-label">按知识库选择</div>
          <div className="chat-kb-options">
            {knowledgeBases.map((kb, index) => {
              const checked = value.includes(kb.id);
              return (
                <label className={`chat-kb-option${checked ? " selected" : ""}`} key={kb.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || (checked && value.length === 1)}
                    onChange={() => toggle(kb.id)}
                  />
                  <span className="chat-kb-check">{checked ? <Check size={13} /> : null}</span>
                  <span className={`chat-kb-color tone-${index % 6}`} aria-hidden="true" />
                  <span className="chat-kb-option-copy">
                    <strong>{kb.name}</strong>
                    <small>{kb.description || `${kb.doc_count} 个文档`}</small>
                  </span>
                </label>
              );
            })}
          </div>
          {error ? <p className="chat-kb-error" role="alert">{error}</p> : null}
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

export function ChatWorkspace({ initialInput = "" }: { initialInput?: string }) {
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
    selectedKbIds,
    updatingKbSelection,
    kbSelectionError,
    updateKnowledgeBaseSelection,
    sendMessage,
    retryMessage,
    cancelMessage,
    submitFeedback,
    clearFeedback,
    isFavorite,
    toggleFavorite,
  } = useConversation();

  const [input, setInput] = useState(initialInput);
  const [isComposing, setIsComposing] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const previousMessageCountRef = useRef(0);
  const followStreamRef = useRef(true);
  const [previewTarget, setPreviewTarget] = useState<DocumentPreviewTarget | null>(null);
  const previewTriggerRef = useRef<HTMLElement | null>(null);
  const [chatModels, setChatModels] = useState<ChatModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("auto");
  const [shareState, setShareState] = useState<{ busy: boolean; url: string; copied: boolean; error: string }>({
    busy: false,
    url: "",
    copied: false,
    error: "",
  });

  const currentConversation = conversations.find((c) => c.conversation_id === currentId);
  const selectedKnowledgeBases = availableKbs.filter((kb) => selectedKbIds.includes(kb.id));
  const currentFavorite = currentId ? isFavorite(currentId) : false;
  const userName = me?.user.name?.trim() || me?.user.email?.split("@")[0] || "你";
  const filesRefreshKey = messages
    .map((message) => `${message.message_id}:${message.status}:${message.citations.length}`)
    .join("|");

  const selectedModelOption = chatModels.find((model) => model.id === selectedModel);
  const runtimeOptions = {
    model_id: selectedModel || undefined,
    thinking_enabled: thinkingMode === "auto" ? undefined : thinkingMode === "deep",
  };

  useEffect(() => {
    let active = true;
    getChatModels().then((catalog) => {
      if (!active) return;
      setChatModels(catalog.models);
      setSelectedModel(catalog.default_model_id);
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

  const handleCitationClick = (citation: Citation) => {
    previewTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setPreviewTarget(previewTargetFromCitation(citation));
    setRightOpen(true);
  };

  const closeFilesPanel = () => {
    setRightOpen(false);
    window.requestAnimationFrame(() => previewTriggerRef.current?.focus());
  };

  const shareConversation = async () => {
    if (!currentId || shareState.busy) return;
    setShareState({ busy: true, url: "", copied: false, error: "" });
    try {
      const share = await createConversationShare(currentId, currentConversation?.title);
      const url = new URL(share.share_url, window.location.origin).toString();
      const copied = await copyToClipboard(url);
      setShareState({ busy: false, url, copied, error: "" });
    } catch (error) {
      setShareState({
        busy: false,
        url: "",
        copied: false,
        error: error instanceof Error ? error.message : "创建分享失败",
      });
    }
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
              <span className="dm-chat-agent-name">油条</span>
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
            <div className="dm-share-status" aria-live="polite">
              {shareState.url ? (
                <a href={shareState.url} target="_blank" rel="noreferrer">
                  {shareState.copied ? "分享链接已复制" : "打开分享链接"}
                </a>
              ) : shareState.error ? <span>{shareState.error}</span> : null}
            </div>
            <div className="dm-chat-session-actions">
              <IconButton
                aria-label="分享当前会话"
                disabled={!currentId || messages.length === 0 || shareState.busy}
                onClick={() => void shareConversation()}
                title="生成并复制只读分享链接"
              >
                <Share2 size={18} />
              </IconButton>
              <IconButton
                aria-label={rightOpen ? "关闭会话文件" : "打开会话文件"}
                className={`dm-file-preview-toggle ${rightOpen ? "active" : ""}`}
                onClick={(event) => {
                  if (rightOpen) {
                    closeFilesPanel();
                  } else {
                    previewTriggerRef.current = event.currentTarget;
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
                  <KnowledgeBasePicker
                    knowledgeBases={availableKbs}
                    value={selectedKbIds}
                    disabled={!!streamingId || updatingKbSelection}
                    error={kbSelectionError}
                    onChange={updateKnowledgeBaseSelection}
                  />
                  {chatModels.length > 0 ? (
                    <>
                      <ModelPicker
                        models={chatModels}
                        value={selectedModel}
                        disabled={!!streamingId}
                        onChange={(model) => {
                          setSelectedModel(model.id);
                          setThinkingMode((current) =>
                            model.thinking_mode === "always_on" && current === "fast"
                              ? "deep"
                              : model.thinking_mode === "unsupported" && current === "deep"
                                ? "fast"
                                : current
                          );
                        }}
                      />
                      <ThinkingModePicker
                        mode={thinkingMode}
                        model={selectedModelOption}
                        disabled={!!streamingId}
                        onChange={setThinkingMode}
                      />
                    </>
                  ) : null}
                  {selectedKnowledgeBases.length > 0 ? (
                    <div className="dm-kb-selection-badges" aria-label="当前对话知识库">
                      {selectedKnowledgeBases.map((kb, index) => (
                        <span
                          className={`dm-kb-badge tone-${index % 6}`}
                          title={kb.name}
                          key={kb.id}
                        >
                          <span aria-hidden="true" />
                          {kb.name}
                        </span>
                      ))}
                    </div>
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
          onClose={closeFilesPanel}
        />
      </div>

    </>
  );
}
