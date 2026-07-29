"use client";

import { useEffect, useRef } from "react";
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
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading) onCancel();
      if (event.key === "Enter" && !loading) onConfirm();
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
      data-testid="conversation-delete-dialog-backdrop"
    >
      <div
        aria-describedby="conversation-delete-description"
        aria-labelledby="conversation-delete-title"
        aria-modal="true"
        className="dm-confirm-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="alertdialog"
        data-testid="conversation-delete-dialog"
      >
        <div className="dm-confirm-dialog-heading">
          <span className="dm-confirm-dialog-icon" aria-hidden="true">
            <TriangleAlert size={20} />
          </span>
          <h2 id="conversation-delete-title">{title}</h2>
        </div>
        <p id="conversation-delete-description">{description}</p>
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
