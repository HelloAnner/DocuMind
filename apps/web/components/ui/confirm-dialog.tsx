"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, TriangleAlert } from "lucide-react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  loading?: boolean;
  error?: string | null;
  /** 可选的 DOM 测试锚点，供调用方保留自己的测试标识。 */
  testId?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = "确认",
  cancelText = "取消",
  loading = false,
  error,
  testId,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogId = useId();
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // 弹窗打开期间始终消费 Esc/Enter（同一事件还会冒泡到 window，其他面板据此让路）；
      // loading 时只拦截不动作，避免删除进行中被上层面板顺手关掉。
      if (event.key === "Escape") {
        event.preventDefault();
        if (!loading) onCancel();
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (!loading) onConfirm();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [loading, onCancel, onConfirm, open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="dm-confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!loading) onCancel();
      }}
      data-testid={testId ? `${testId}-backdrop` : undefined}
    >
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="dm-confirm-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="alertdialog"
        data-testid={testId}
      >
        <div className="dm-confirm-dialog-heading">
          <span className="dm-confirm-dialog-icon" aria-hidden="true">
            <TriangleAlert size={20} />
          </span>
          <h2 id={titleId}>{title}</h2>
        </div>
        <p id={descriptionId}>{description}</p>
        {error ? (
          <p className="dm-confirm-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dm-confirm-dialog-actions">
          <button
            className="dm-confirm-dialog-cancel"
            disabled={loading}
            onClick={onCancel}
            type="button"
          >
            {cancelText}
          </button>
          <button
            className="dm-confirm-dialog-confirm"
            disabled={loading}
            onClick={onConfirm}
            ref={confirmRef}
            type="button"
          >
            {loading ? <LoaderCircle className="dm-confirm-dialog-spinner" size={15} /> : null}
            <span>{loading ? "删除中…" : confirmText}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
