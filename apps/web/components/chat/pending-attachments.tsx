"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, FileText, RefreshCw, X } from "lucide-react";
import {
  apiErrorMessage,
  MAX_MESSAGE_FILES,
  uploadChatFile,
  uploadPreflightError,
  type FileUploadProgress,
} from "@/lib/api";
import type { ChatFile } from "@/lib/types";
import { fileExtLabel, formatFileSize } from "./chat-file-card";

export interface PendingAttachment {
  key: string;
  file: File;
  status: "uploading" | "ready" | "error";
  progress: number;
  uploaded?: ChatFile;
  error?: string;
  retryable?: boolean;
}

interface PendingAttachmentListProps {
  attachments: PendingAttachment[];
  label?: string;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}

export function PendingAttachmentList({
  attachments,
  label = "待发送文件",
  onRemove,
  onRetry,
}: PendingAttachmentListProps) {
  if (attachments.length === 0) return null;
  return (
    <div className="dm-composer-attachments" role="list" aria-label={label}>
      {attachments.map((attachment) => (
        <div
          className={`dm-composer-attachment ${attachment.status}`}
          key={attachment.key}
          role="listitem"
        >
          <span className="dm-conversation-file-icon" aria-hidden="true">
            <FileText size={16} />
            <small>{fileExtLabel({ name: attachment.file.name, mime_type: attachment.file.type })}</small>
          </span>
          <span className="dm-composer-attachment-copy">
            <strong title={attachment.file.name}>{attachment.file.name}</strong>
            {attachment.status === "uploading" ? (
              <span aria-label={`上传进度 ${attachment.progress}%`} className="dm-composer-attachment-progress" role="progressbar" aria-valuenow={attachment.progress} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${attachment.progress}%` }} />
              </span>
            ) : attachment.status === "error" ? (
              <span className="dm-composer-attachment-error">
                <AlertCircle size={11} aria-hidden="true" />
                {attachment.error ?? "上传失败"}
              </span>
            ) : (
              <span className="dm-composer-attachment-meta">{formatFileSize(attachment.file.size)}</span>
            )}
          </span>
          <span className="dm-composer-attachment-actions">
            {attachment.status === "error" && attachment.retryable !== false ? (
              <button aria-label={`重试上传 ${attachment.file.name}`} onClick={() => onRetry(attachment.key)} type="button">
                <RefreshCw size={13} />
              </button>
            ) : null}
            <button aria-label={`移除附件 ${attachment.file.name}`} onClick={() => onRemove(attachment.key)} type="button">
              <X size={13} />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

export function useAttachmentQueue(
  conversationId?: string | null,
  onUploaded?: (attachment: PendingAttachment) => void
) {
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef<PendingAttachment[]>(attachments);
  attachmentsRef.current = attachments;
  const abortRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const controllers = abortRef.current;
    return () => {
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  // 切换会话时丢弃上一条会话的附件：文件已绑定旧会话，带到新会话后端会直接拒绝。
  useEffect(() => {
    if (attachmentsRef.current.length === 0) return;
    abortRef.current.forEach((controller) => controller.abort());
    abortRef.current.clear();
    setAttachments([]);
  }, [conversationId]);

  const update = (key: string, patch: Partial<PendingAttachment>) => {
    setAttachments((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item))
    );
  };

  const fail = (key: string, error: string, retryable: boolean) => {
    abortRef.current.delete(key);
    update(key, { status: "error", error, retryable, progress: 0 });
  };

  const startUpload = (key: string, file: File) => {
    const rejected = uploadPreflightError(file);
    if (rejected) {
      fail(key, rejected, false);
      return;
    }
    const controller = new AbortController();
    abortRef.current.get(key)?.abort();
    abortRef.current.set(key, controller);
    uploadChatFile(
      file,
      (progress: FileUploadProgress) => update(key, { progress: progress.percent }),
      controller.signal,
      conversationIdRef.current ?? undefined
    )
      .then((uploaded) => {
        abortRef.current.delete(key);
        update(key, { status: "ready", progress: 100, uploaded, error: undefined, retryable: undefined });
        onUploadedRef.current?.({ key, file, status: "ready", progress: 100, uploaded });
      })
      .catch((error: unknown) => {
        if ((error as Error).name === "AbortError") return;
        fail(key, apiErrorMessage(error, "上传失败"), true);
      });
  };

  const addFiles = (files: Iterable<File>) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    const batchKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    // 只有真正能上传的文件占额度：本地就被拒的文件不该把同一批里后面的正常文件挤掉。
    let slots = Math.max(
      0,
      MAX_MESSAGE_FILES - attachmentsRef.current.filter((item) => item.status !== "error").length
    );
    const created: PendingAttachment[] = list.map((file, index) => {
      const key = `att-${batchKey}-${index}`;
      const rejected = uploadPreflightError(file);
      if (rejected) {
        return { key, file, status: "error", progress: 0, error: rejected, retryable: false };
      }
      if (slots <= 0) {
        return {
          key,
          file,
          status: "error",
          progress: 0,
          error: `单条消息最多关联 ${MAX_MESSAGE_FILES} 个文件`,
          retryable: false,
        };
      }
      slots -= 1;
      return { key, file, status: "uploading", progress: 0 };
    });
    setAttachments((current) => [...current, ...created]);
    created.forEach((item) => {
      if (item.status === "uploading") startUpload(item.key, item.file);
    });
  };

  const removeAttachment = (key: string) => {
    abortRef.current.get(key)?.abort();
    abortRef.current.delete(key);
    setAttachments((current) => current.filter((item) => item.key !== key));
  };

  const retryAttachment = (key: string) => {
    const target = attachmentsRef.current.find((item) => item.key === key);
    if (!target || target.status === "uploading") return;
    update(key, { status: "uploading", error: undefined, progress: 0 });
    startUpload(key, target.file);
  };

  /** 取出已上传完成的附件（发送时调用），失败时可用 restore 放回输入区。 */
  const consumeReady = (): PendingAttachment[] => {
    const ready = attachmentsRef.current.filter((item) => item.status === "ready" && item.uploaded);
    if (ready.length === 0) return [];
    const consumed = new Set(ready.map((item) => item.key));
    setAttachments((current) => current.filter((item) => !consumed.has(item.key)));
    return ready;
  };

  const restore = (items: PendingAttachment[]) => {
    if (items.length === 0) return;
    const keys = new Set(items.map((item) => item.key));
    setAttachments((current) => [
      ...items,
      ...current.filter((item) => !keys.has(item.key)),
    ]);
  };

  return {
    attachments,
    addFiles,
    removeAttachment,
    retryAttachment,
    consumeReady,
    restore,
    uploadingCount: attachments.filter((item) => item.status === "uploading").length,
  };
}
