"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  Maximize2,
  Minimize2,
  Quote,
  RefreshCw,
  X,
} from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import {
  DocumentPreview,
  previewTargetPage,
  type DocumentPreviewTarget,
} from "./document-preview";
import { getConversationFiles } from "@/lib/api";
import type { ConversationFile } from "@/lib/types";

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

export function ConversationFilesPanel({
  conversationId,
  open,
  previewTarget,
  refreshKey,
  onPreviewTargetChange,
  onClose,
}: ConversationFilesPanelProps) {
  const [state, setState] = useState<FileListState>({ status: "idle", files: [] });
  const [retryToken, setRetryToken] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setState({ status: "idle", files: [] });
  }, [conversationId]);

  useEffect(() => {
    if (!open) {
      setMaximized(false);
      return;
    }
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("[data-preview-initial-focus]")?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
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

  const citedFileCount = useMemo(
    () => state.files.filter((file) => file.citation_count > 0).length,
    [state.files]
  );
  const targetPage = previewTarget ? previewTargetPage(previewTarget) : null;

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
                  : state.files.length > 0
                    ? `${state.files.length} 个引用文件`
                    : "正文引用的文件"}
              </span>
            </div>
          </div>
          <div className="dm-right-rail-actions">
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
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
