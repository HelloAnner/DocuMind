"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  Grid2X2,
  List,
  Maximize2,
  Minimize2,
  Quote,
  RefreshCw,
  Search,
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
import { ChatFileInlinePreview } from "./chat-file-inline-preview";
import { matchesFileQuery } from "./file-preview-utils";
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

type Scope = "conversation" | "mine" | "space";
type ViewMode = "grid" | "list";
type FileScope = "personal" | "space";

interface LocalPreview {
  file: ChatFile;
  scope: FileScope;
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

/** 下载/删除动作在两套视图里共用，避免 grid 与 list 行为分叉。 */
function ChatFileActions({
  file,
  onDelete,
}: {
  file: ChatFile;
  onDelete: (file: ChatFile) => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");

  return (
    <span className="dm-chat-file-row-actions">
      {error ? (
        <span className="dm-chat-file-action-error" role="alert">
          {error}
        </span>
      ) : null}
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
  );
}

function ChatFileRow({
  file,
  linked,
  onPreview,
  onDelete,
}: {
  file: ChatFile;
  linked: boolean;
  onPreview: (file: ChatFile) => void;
  onDelete: (file: ChatFile) => void;
}) {
  return (
    <div className="dm-chat-file-row">
      <button
        aria-label={`预览 ${file.name}`}
        className="dm-chat-file-row-open"
        onClick={() => onPreview(file)}
        type="button"
      >
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
        </span>
      </button>
      <ChatFileActions file={file} onDelete={onDelete} />
    </div>
  );
}

function ChatFileTile({
  file,
  linked,
  onPreview,
  onDelete,
}: {
  file: ChatFile;
  linked: boolean;
  onPreview: (file: ChatFile) => void;
  onDelete: (file: ChatFile) => void;
}) {
  return (
    <div className="dm-conversation-file-tile-wrap">
      <button
        aria-label={`预览 ${file.name}`}
        className="dm-conversation-file-tile"
        onClick={() => onPreview(file)}
        type="button"
      >
        <span className="dm-conversation-file-tile-preview" aria-hidden="true">
          <FileText size={26} />
          <small>{fileExtLabel(file)}</small>
        </span>
        <span className="dm-conversation-file-tile-name" title={file.name}>
          {file.name}
        </span>
        <span className="dm-conversation-file-tile-meta">
          {file.size_bytes > 0 ? formatFileSize(file.size_bytes) : fileSourceLabel(file.source)}
          {linked ? " · 本会话" : ""}
        </span>
      </button>
      <span className="dm-conversation-file-tile-actions">
        <ChatFileActions file={file} onDelete={onDelete} />
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
  const [tab, setTab] = useState<Scope>("mine");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [localPreview, setLocalPreview] = useState<LocalPreview | null>(null);
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
  }, tab === "space" ? "space" : "personal");

  const isPreviewing = previewTarget !== null || localPreview !== null;
  const isChatScope = tab !== "conversation";

  useEffect(() => {
    setState({ status: "idle", files: [] });
    setLocalPreview(null);
  }, [conversationId]);

  useEffect(() => {
    if (!open) {
      setMaximized(false);
      setTab("mine");
      setQuery("");
      setLocalPreview(null);
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

  // 右侧同时只能展示一种预览：引用原文优先于用户文件预览。
  useEffect(() => {
    if (previewTarget) setLocalPreview(null);
  }, [previewTarget]);

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
    if (!open || tab === "conversation") return;
    let cancelled = false;
    setMyState({ status: "loading", files: [] });
    listFiles(undefined, tab === "space" ? "space" : "personal")
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

  const filteredMyFiles = useMemo(
    () => sortedMyFiles.filter((file) => matchesFileQuery(file.name, query)),
    [sortedMyFiles, query]
  );

  const filteredConversationFiles = useMemo(
    () =>
      state.files.filter(
        (file) =>
          matchesFileQuery(file.doc_title, query) ||
          matchesFileQuery(file.file_name, query)
      ),
    [state.files, query]
  );

  const totalCount = isChatScope ? myState.files.length : state.files.length;
  const visibleCount = isChatScope ? filteredMyFiles.length : filteredConversationFiles.length;
  const hasQuery = query.trim().length > 0;

  const changeTab = (next: Scope) => {
    if (next === tab) return;
    setTab(next);
    setQuery("");
    setLocalPreview(null);
  };

  const openFilePreview = (file: ChatFile) => {
    setLocalPreview({ file, scope: tab === "space" ? "space" : "personal" });
  };

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

  const previewTitle = previewTarget?.doc_title ?? localPreview?.file.name ?? "会话文件";
  const previewSubtitle = previewTarget
    ? targetPage
      ? `第 ${targetPage} ${previewTarget.anchor?.slide ? "张" : "页"}`
      : "原文依据"
    : localPreview
      ? [
          localPreview.scope === "space" ? "空间文件" : "我的文件",
          fileExtLabel(localPreview.file),
          localPreview.file.size_bytes > 0 ? formatFileSize(localPreview.file.size_bytes) : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : hasQuery
        ? `${visibleCount}/${totalCount} 个${tab === "conversation" ? "引用文件" : "文件"}`
        : tab === "conversation"
          ? totalCount > 0
            ? `${totalCount} 个引用文件`
            : "正文引用的文件"
          : `${totalCount} 个文件`;

  const listEmptyCopy = hasQuery
    ? { title: "没有匹配的文件", description: "换个关键词再试试。" }
    : tab === "conversation"
      ? conversationId
        ? { title: "这段对话还没有相关文件", description: "只有正文实际引用原文时，文件才会出现在列表中。" }
        : { title: "当前还没有会话文件", description: "开始问答后，正文实际引用的文档会显示在这里。" }
      : tab === "space"
        ? { title: "空间里还没有文件", description: "上传到空间的文件会出现在这里，并可供所有成员使用。" }
        : { title: "还没有上传过文件", description: "在输入框中点击回形针，或把文件拖到输入区即可上传。" };

  const showEmpty = hasQuery
    ? visibleCount === 0 && totalCount > 0
    : tab === "conversation"
      ? !conversationId || (state.status === "ready" && totalCount === 0)
      : myState.status === "ready" && totalCount === 0;

  const listFailed = tab === "conversation"
    ? state.status === "failed"
    : myState.status === "failed";

  return (
    <aside
      aria-hidden={!open}
      aria-label="会话文件"
      className={`dm-right-rail ${open ? "open" : ""} ${maximized ? "maximized" : ""}`}
      data-view={isPreviewing ? "preview" : "list"}
      inert={!open}
      ref={panelRef}
    >
      <div className="dm-right-rail-inner">
        <div className="dm-conversation-files-header">
          <div className="dm-conversation-files-heading">
            {isPreviewing ? (
              <IconButton
                aria-label="返回文件列表"
                className="dm-conversation-files-back"
                onClick={() => {
                  if (previewTarget) onPreviewTargetChange(null);
                  else setLocalPreview(null);
                }}
              >
                <ArrowLeft size={17} />
              </IconButton>
            ) : (
              <span className="dm-conversation-files-heading-icon" aria-hidden="true">
                <FolderOpen size={18} />
              </span>
            )}
            <div>
              <strong title={previewTitle}>{previewTitle}</strong>
              <span>{previewSubtitle}</span>
            </div>
          </div>
          <div className="dm-right-rail-actions">
            {!isPreviewing ? (
              <IconButton
                aria-label="刷新文件列表"
                className="dm-right-rail-maximize"
                onClick={() => {
                  if (tab !== "conversation") setMyRetryToken((value) => value + 1);
                  else setRetryToken((value) => value + 1);
                }}
                title="刷新"
              >
                <RefreshCw size={15} />
              </IconButton>
            ) : null}
            {isPreviewing ? (
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
          ) : localPreview ? (
            <ChatFileInlinePreview file={localPreview.file} />
          ) : (
            <div className="dm-conversation-files">
              <Segmented
                className="dm-conversation-files-tabs"
                onChange={changeTab}
                options={[
                  { value: "mine", label: "我的文件" },
                  { value: "space", label: "空间文件" },
                  { value: "conversation", label: "会话引用" },
                ]}
                value={tab}
              />

              <div className="dm-conversation-files-tools">
                <label className="dm-conversation-files-search">
                  <Search size={14} aria-hidden="true" />
                  <input
                    aria-label={tab === "conversation" ? "搜索引用文件" : "搜索文件"}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={tab === "conversation" ? "搜索引用文件" : "搜索文件"}
                    type="search"
                    value={query}
                  />
                  {hasQuery ? (
                    <button
                      aria-label="清空搜索"
                      onClick={() => setQuery("")}
                      type="button"
                    >
                      <X size={13} />
                    </button>
                  ) : null}
                </label>
                <div
                  aria-label="文件显示方式"
                  className="dm-file-view-toggle"
                  role="group"
                >
                  <IconButton
                    aria-label="网格视图"
                    aria-pressed={viewMode === "grid"}
                    className={viewMode === "grid" ? "active" : ""}
                    onClick={() => setViewMode("grid")}
                  >
                    <Grid2X2 size={15} />
                  </IconButton>
                  <IconButton
                    aria-label="列表视图"
                    aria-pressed={viewMode === "list"}
                    className={viewMode === "list" ? "active" : ""}
                    onClick={() => setViewMode("list")}
                  >
                    <List size={15} />
                  </IconButton>
                </div>
              </div>

              {isChatScope ? (
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
                      {tab === "space" ? "上传到空间" : "上传文件"}
                    </button>
                  </div>

                  <PendingAttachmentList
                    attachments={uploads}
                    label="文件上传队列"
                    onRemove={removeUpload}
                    onRetry={retryUpload}
                  />
                </>
              ) : null}

              {(isChatScope ? myState.status === "loading" : state.status === "loading") &&
              totalCount === 0 ? (
                <div className="dm-conversation-files-loading" aria-live="polite">
                  <span />
                  <span />
                  <span />
                </div>
              ) : null}

              {tab === "conversation" && state.files.length > 0 ? (
                <div className="dm-conversation-files-summary" aria-label="引用文件概览">
                  <span>
                    <Quote size={13} aria-hidden="true" />
                    已引用 {citedFileCount}
                  </span>
                  {hasQuery ? <span>匹配 {filteredConversationFiles.length}</span> : null}
                </div>
              ) : null}

              {showEmpty ? (
                <div className="dm-conversation-files-empty">
                  <FolderOpen size={30} aria-hidden="true" />
                  <strong>{listEmptyCopy.title}</strong>
                  <p>{listEmptyCopy.description}</p>
                </div>
              ) : null}

              {!showEmpty && tab === "conversation" && filteredConversationFiles.length > 0 ? (
                viewMode === "grid" ? (
                  <div className="dm-conversation-file-grid">
                    {filteredConversationFiles.map((file) => {
                      const unavailable = file.source_status !== "available";
                      return (
                        <button
                          className="dm-conversation-file-tile"
                          disabled={unavailable}
                          key={file.doc_id}
                          onClick={() => onPreviewTargetChange(previewTargetFromFile(file))}
                          type="button"
                        >
                          <span className="dm-conversation-file-tile-preview" aria-hidden="true">
                            <FileText size={26} />
                            <small>{fileTypeLabel(file.file_type)}</small>
                          </span>
                          <span className="dm-conversation-file-tile-name" title={file.doc_title}>
                            {file.doc_title}
                          </span>
                          <span className="dm-conversation-file-tile-meta">
                            {[
                              file.kb_name,
                              file.citation_count > 0 ? "已引用" : "",
                              unavailable ? "原文不可用" : "",
                            ]
                              .filter(Boolean)
                              .join(" · ") || "引用文件"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="dm-conversation-file-list">
                    {filteredConversationFiles.map((file) => {
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
                )
              ) : null}

              {isChatScope && !showEmpty && filteredMyFiles.length > 0 ? (
                viewMode === "grid" ? (
                  <div className="dm-conversation-file-grid">
                    {filteredMyFiles.map((file) => (
                      <ChatFileTile
                        file={file}
                        key={file.id}
                        linked={linkedIds.has(file.id)}
                        onDelete={setDeleteTarget}
                        onPreview={openFilePreview}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="dm-conversation-file-list">
                    {filteredMyFiles.map((file) => (
                      <ChatFileRow
                        file={file}
                        key={file.id}
                        linked={linkedIds.has(file.id)}
                        onDelete={setDeleteTarget}
                        onPreview={openFilePreview}
                      />
                    ))}
                  </div>
                )
              ) : null}

              {listFailed ? (
                <div className="dm-conversation-files-error" role="alert">
                  <span>
                    {tab === "conversation"
                      ? "会话文件加载失败"
                      : myState.status === "failed" ? myState.error || "文件列表加载失败" : "文件列表加载失败"}
                  </span>
                  <button
                    onClick={() => {
                      if (tab === "conversation") setRetryToken((current) => current + 1);
                      else setMyRetryToken((current) => current + 1);
                    }}
                    type="button"
                  >
                    <RefreshCw size={13} />
                    重试
                  </button>
                </div>
              ) : null}
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
