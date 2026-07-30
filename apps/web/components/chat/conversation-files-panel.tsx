"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  Quote,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { DocumentPreview, type DocumentPreviewTarget } from "./document-preview";
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

  useEffect(() => {
    setState({ status: "idle", files: [] });
  }, [conversationId]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
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

  const summary = useMemo(() => {
    const cited = state.files.filter((file) => file.citation_count > 0).length;
    const retrieved = state.files.filter((file) => file.retrieval_count > 0).length;
    return { cited, retrieved };
  }, [state.files]);

  return (
    <aside
      aria-hidden={!open}
      aria-label="会话文件"
      className={`dm-right-rail ${open ? "open" : ""}`}
      data-view={previewTarget ? "preview" : "list"}
      inert={!open}
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
              <strong>{previewTarget ? "文件预览" : "会话文件"}</strong>
              <span>
                {previewTarget
                  ? "真实原文"
                  : state.files.length > 0
                    ? `${state.files.length} 个相关文件`
                    : "检索与引用记录"}
              </span>
            </div>
          </div>
          <IconButton aria-label="关闭会话文件" className="dm-right-rail-close" onClick={onClose}>
            <X size={17} />
          </IconButton>
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
                <div className="dm-conversation-files-summary" aria-label="文件来源概览">
                  <span>
                    <Search size={13} aria-hidden="true" />
                    检索到 {summary.retrieved}
                  </span>
                  <span>
                    <Quote size={13} aria-hidden="true" />
                    已引用 {summary.cited}
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
                  <p>开始问答后，检索和引用过的真实文档会显示在这里。</p>
                </div>
              ) : state.status === "ready" && state.files.length === 0 ? (
                <div className="dm-conversation-files-empty">
                  <FolderOpen size={30} aria-hidden="true" />
                  <strong>这段对话还没有相关文件</strong>
                  <p>只有发生真实知识检索或原文引用时，文件才会出现在列表中。</p>
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
                              <span className="cited">引用 {file.citation_count}</span>
                            ) : null}
                            {file.retrieval_count > 0 ? (
                              <span>检索 {file.retrieval_count} 轮</span>
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
