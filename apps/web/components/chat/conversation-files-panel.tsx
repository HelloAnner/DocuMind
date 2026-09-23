"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  Maximize2,
  Minimize2,
  Quote,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { Segmented } from "@/components/ui/segmented";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DocumentPreview,
  previewTargetPage,
  type DocumentPreviewTarget,
} from "./document-preview";
import {
  apiErrorMessage,
  deleteFile,
  downloadChatFile,
  getConversationFiles,
  listFiles,
} from "@/lib/api";
import type { ChatFile, ConversationFile } from "@/lib/types";
import { fileExtLabel, fileSourceLabel, formatFileSize } from "./chat-file-card";
import { PendingAttachmentList, useAttachmentQueue } from "./pending-attachments";

interface ConversationFilesPanelProps {
  conversationId: string | null;
  open: boolean;
  previewTarget: DocumentPreviewTarget | null;
  refreshKey: string;
  onPreviewTargetChange: (target: DocumentPreviewTarget | null) => void;
  onClose: () => void;
}

type FileListState =
  | { status: "idle"; files: ConversationFile[] }
  | { status: "loading"; files: ConversationFile[] }
  | { status: "ready"; files: ConversationFile[] }
  | { status: "failed"; files: ConversationFile[]; error: string };

type ChatFileListState =
  | { status: "idle"; files: ChatFile[] }
  | { status: "loading"; files: ChatFile[] }
  | { status: "ready"; files: ChatFile[] }
  | { status: "failed"; files: ChatFile[]; error: string };

function previewTargetFromFile(file: ConversationFile): DocumentPreviewTarget {
  return {
    doc_id: file.doc_id,
    doc_title: file.doc_title,
    file_type: file.file_type,
    page_range: file.preview_page_range,
    source_status: file.source_status,
    anchor: file.preview_anchor,
    quote: file.preview_quote,
  };
}

function fileTypeLabel(fileType: string) {
  const normalized = fileType.trim().replace(/^\./, "").toUpperCase();
  return normalized && normalized !== "UNKNOWN" ? normalized : "文件";
}

function formatDateTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ChatFileRow({
  file,
  linked,
  onDelete,
}: {
  file: ChatFile;
  linked: boolean;
  onDelete: (file: ChatFile) => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="dm-chat-file-row">
      <span className="dm-conversation-file-icon" aria-hidden="true">
        <FileText size={18} />
        <small>{fileExtLabel(file)}</small>
      </span>
      <span className="dm-conversation-file-copy">
        <strong title={file.name}>{file.name}</strong>
        <span className="dm-conversation-file-context">
          <span>{fileSourceLabel(file.source)}</span>
          {file.size_bytes > 0 ? <span>{formatFileSize(file.size_bytes)}</span> : null}
          {linked ? <span className="cited">本会话</span> : null}
          {file.created_at ? <span>{formatDateTime(file.created_at)}</span> : null}
        </span>
        {error ? <span className="dm-feedback-error is-inline" role="alert">{error}</span> : null}
      </span>
      <span className="dm-chat-file-row-actions">
        <IconButton
          aria-label={`下载 ${file.name}`}
          disabled={downloading}
          onClick={() => {
            if (downloading) return;
            setDownloading(true);
            setError("");
            downloadChatFile(file)
              .catch((downloadError) => setError(apiErrorMessage(downloadError, "下载失败")))
              .finally(() => setDownloading(false));
          }}
          title="下载"
        >
          <Download size={15} />
        </IconButton>
        <IconButton
          aria-label={`删除 ${file.name}`}
          onClick={() => onDelete(file)}
          title="删除"
        >
          <Trash2 size={15} />
        </IconButton>
      </span>
    </div>
  );
}

export function ConversationFilesPanel({
  conversationId,
  open,
  previewTarget,
  refreshKey,
  onPreviewTargetChange,
  onClose,
}: ConversationFilesPanelProps) {
  const [state, setState] = useState<FileListState>({ status: "idle", files: [] });
  const [myState, setMyState] = useState<ChatFileListState>({ status: "idle", files: [] });
  const [tab, setTab] = useState<"conversation" | "mine">("conversation");
  const [retryToken, setRetryToken] = useState(0);
  const [myRetryToken, setMyRetryToken] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ChatFile | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const {
    attachments: uploads,
    addFiles: addUploads,
    removeAttachment: removeUpload,
    retryAttachment: retryUpload,
  } = useAttachmentQueue(conversationId, (attachment) => {
    removeUpload(attachment.key);
    setMyRetryToken((value) => value + 1);
  });

  useEffect(() => {
    setState({ status: "idle", files: [] });
  }, [conversationId]);

  useEffect(() => {
    if (!open) {
      setMaximized(false);
      setTab("conversation");
      return;
    }
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("[data-preview-initial-focus]")?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      // 删除确认弹窗挂在 body 上并自己消费 Esc/Enter（preventDefault），冒泡到 window 时已经处理过。
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !window.matchMedia("(max-width: 1024px)").matches) return;
      const focusable = Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((element) => !element.hidden);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open || !conversationId) return;
    let cancelled = false;
    setState((current) => ({ status: "loading", files: current.files }));

    getConversationFiles(conversationId)
      .then((response) => {
        if (!cancelled) {
          setState({ status: "ready", files: response.files });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState((current) => ({
            status: "failed",
            files: current.files,
            error: error instanceof Error ? error.message : "会话文件加载失败",
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, open, refreshKey, retryToken]);

  useEffect(() => {
    if (!open || tab !== "mine") return;
    let cancelled = false;
    setMyState((current) => ({ status: "loading", files: current.files }));
    listFiles()
      .then((response) => {
        if (!cancelled) setMyState({ status: "ready", files: response.files });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMyState((current) => ({
            status: "failed",
            files: current.files,
            error: error instanceof Error ? error.message : "文件列表加载失败",
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab, myRetryToken]);

  const citedFileCount = useMemo(
    () => state.files.filter((file) => file.citation_count > 0).length,
    [state.files]
  );
  const targetPage = previewTarget ? previewTargetPage(previewTarget) : null;

  const linkedIds = useMemo(() => {
    const ids = new Set<string>();
    if (conversationId) {
      for (const file of myState.files) {
        if (file.conversation_id === conversationId) ids.add(file.id);
      }
    }
    return ids;
  }, [conversationId, myState.files]);

  const sortedMyFiles = useMemo(() => {
    return [...myState.files].sort((a, b) => {
      const linkedDelta = Number(linkedIds.has(b.id)) - Number(linkedIds.has(a.id));
      if (linkedDelta !== 0) return linkedDelta;
      return b.created_at.localeCompare(a.created_at);
    });
  }, [myState.files, linkedIds]);

  const confirmDelete = async () => {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteFile(deleteTarget.id);
      setMyState((current) => ({
        status: current.status === "idle" ? "idle" : "ready",
        files: current.files.filter((file) => file.id !== deleteTarget.id),
      }));
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(apiErrorMessage(error, "删除失败，请重试"));
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <aside
      aria-hidden={!open}
      aria-label="会话文件"
      className={`dm-right-rail ${open ? "open" : ""} ${maximized ? "maximized" : ""}`}
      data-view={previewTarget ? "preview" : "list"}
      inert={!open}
      ref={panelRef}
    >
      <div className="dm-right-rail-inner">
        <div className="dm-conversation-files-header">
          <div className="dm-conversation-files-heading">
            {previewTarget ? (
              <IconButton
                aria-label="返回会话文件列表"
                className="dm-conversation-files-back"
                onClick={() => onPreviewTargetChange(null)}
              >
                <ArrowLeft size={17} />
              </IconButton>
            ) : (
              <span className="dm-conversation-files-heading-icon" aria-hidden="true">
                <FolderOpen size={18} />
              </span>
            )}
            <div>
              <strong title={previewTarget?.doc_title}>
                {previewTarget?.doc_title ?? "会话文件"}
              </strong>
              <span>
                {previewTarget
                  ? targetPage
                    ? `第 ${targetPage} ${previewTarget.anchor?.slide ? "张" : "页"}`
                    : "原文依据"
                  : tab === "mine"
                    ? `${myState.files.length} 个文件`
                    : state.files.length > 0
                      ? `${state.files.length} 个引用文件`
                      : "正文引用的文件"}
              </span>
            </div>
          </div>
          <div className="dm-right-rail-actions">
            {!previewTarget ? (
              <IconButton
                aria-label="刷新文件列表"
                className="dm-right-rail-maximize"
                onClick={() => {
                  if (tab === "mine") setMyRetryToken((value) => value + 1);
                  else setRetryToken((value) => value + 1);
                }}
                title="刷新"
              >
                <RefreshCw size={15} />
              </IconButton>
            ) : null}
            {previewTarget ? (
              <IconButton
                aria-label={maximized ? "还原预览面板" : "最大化预览面板"}
                className="dm-right-rail-maximize"
                onClick={() => setMaximized((current) => !current)}
              >
                {maximized ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
              </IconButton>
            ) : null}
            <IconButton
              aria-label="关闭会话文件"
              className="dm-right-rail-close"
              data-preview-initial-focus
              onClick={onClose}
            >
              <X size={17} />
            </IconButton>
          </div>
        </div>

        <div className="dm-right-rail-body">
          {previewTarget ? (
            <DocumentPreview
              conversationId={conversationId ?? undefined}
              target={previewTarget}
            />
          ) : (
            <div className="dm-conversation-files">
              <Segmented
                className="dm-conversation-files-tabs"
                onChange={setTab}
                options={[
                  { value: "conversation", label: "会话引用" },
                  { value: "mine", label: "我的文件" },
                ]}
                value={tab}
              />

              {tab === "conversation" ? (
                <>
                  {state.files.length > 0 ? (
                    <div className="dm-conversation-files-summary" aria-label="引用文件概览">
                      <span>
                        <Quote size={13} aria-hidden="true" />
                        已引用 {citedFileCount}
                      </span>
                    </div>
                  ) : null}

                  {state.status === "loading" && state.files.length === 0 ? (
                    <div className="dm-conversation-files-loading" aria-live="polite">
                      <span />
                      <span />
                      <span />
                    </div>
                  ) : null}

                  {!conversationId ? (
                    <div className="dm-conversation-files-empty">
                      <FolderOpen size={30} aria-hidden="true" />
                      <strong>当前还没有会话文件</strong>
                      <p>开始问答后，正文实际引用的文档会显示在这里。</p>
                    </div>
                  ) : state.status === "ready" && state.files.length === 0 ? (
                    <div className="dm-conversation-files-empty">
                      <FolderOpen size={30} aria-hidden="true" />
                      <strong>这段对话还没有相关文件</strong>
                      <p>只有正文实际引用原文时，文件才会出现在列表中。</p>
                    </div>
                  ) : null}

                  {state.files.length > 0 ? (
                    <div className="dm-conversation-file-list">
                      {state.files.map((file) => {
                        const unavailable = file.source_status !== "available";
                        return (
                          <button
                            className="dm-conversation-file-row"
                            disabled={unavailable}
                            key={file.doc_id}
                            onClick={() => onPreviewTargetChange(previewTargetFromFile(file))}
                            type="button"
                          >
                            <span className="dm-conversation-file-icon" aria-hidden="true">
                              <FileText size={18} />
                              <small>{fileTypeLabel(file.file_type)}</small>
                            </span>
                            <span className="dm-conversation-file-copy">
                              <strong title={file.doc_title}>{file.doc_title}</strong>
                              <span className="dm-conversation-file-context">
                                {file.kb_name ? <span>{file.kb_name}</span> : null}
                                {file.citation_count > 0 ? (
                                  <span className="cited">已引用</span>
                                ) : null}
                                {unavailable ? <span className="unavailable">原文不可用</span> : null}
                              </span>
                            </span>
                            <ChevronRight size={16} aria-hidden="true" />
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  {state.status === "failed" ? (
                    <div className="dm-conversation-files-error" role="alert">
                      <span>会话文件加载失败</span>
                      <button onClick={() => setRetryToken((current) => current + 1)} type="button">
                        <RefreshCw size={13} />
                        重试
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="dm-my-files-toolbar">
                    <input
                      aria-hidden="true"
                      className="dm-composer-file-input"
                      multiple
                      onChange={(event) => {
                        if (event.target.files && event.target.files.length > 0) {
                          addUploads(Array.from(event.target.files));
                        }
                        event.target.value = "";
                      }}
                      ref={uploadInputRef}
                      tabIndex={-1}
                      type="file"
                    />
                    <button
                      className="dm-my-files-upload"
                      onClick={() => uploadInputRef.current?.click()}
                      type="button"
                    >
                      <Upload size={14} aria-hidden="true" />
                      上传文件
                    </button>
                  </div>

                  <PendingAttachmentList
                    attachments={uploads}
                    label="文件上传队列"
                    onRemove={removeUpload}
                    onRetry={retryUpload}
                  />

                  {myState.status === "loading" && myState.files.length === 0 ? (
                    <div className="dm-conversation-files-loading" aria-live="polite">
                      <span />
                      <span />
                      <span />
                    </div>
                  ) : null}

                  {myState.status === "ready" && myState.files.length === 0 ? (
                    <div className="dm-conversation-files-empty">
                      <FolderOpen size={30} aria-hidden="true" />
                      <strong>还没有上传过文件</strong>
                      <p>在输入框中点击回形针，或把文件拖到输入区即可上传。</p>
                    </div>
                  ) : null}

                  {sortedMyFiles.length > 0 ? (
                    <div className="dm-conversation-file-list">
                      {sortedMyFiles.map((file) => (
                        <ChatFileRow
                          file={file}
                          key={file.id}
                          linked={linkedIds.has(file.id)}
                          onDelete={setDeleteTarget}
                        />
                      ))}
                    </div>
                  ) : null}

                  {myState.status === "failed" ? (
                    <div className="dm-conversation-files-error" role="alert">
                      <span>{myState.error || "文件列表加载失败"}</span>
                      <button onClick={() => setMyRetryToken((current) => current + 1)} type="button">
                        <RefreshCw size={13} />
                        重试
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        cancelText="取消"
        confirmText="删除"
        description={`删除后「${deleteTarget?.name ?? ""}」将无法在会话中继续使用，且不可恢复。`}
        error={deleteError}
        loading={deleteBusy}
        onCancel={() => {
          if (!deleteBusy) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
        onConfirm={() => void confirmDelete()}
        open={deleteTarget !== null}
        testId="chat-file-delete-dialog"
        title="删除文件"
      />
    </aside>
  );
}
