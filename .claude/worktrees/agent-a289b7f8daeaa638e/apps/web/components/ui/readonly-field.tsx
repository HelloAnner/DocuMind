"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { IconButton } from "./icon-button";

interface ReadonlyFieldProps {
  label: string;
  value?: React.ReactNode;
  code?: boolean;
  copyable?: boolean;
}

export function ReadonlyField({ label, value, code, copyable }: ReadonlyFieldProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (typeof value !== "string" || !value) return;
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="dm-readonly-field">
      <span className="dm-readonly-field-label">{label}</span>
      <div className="dm-readonly-field-value">
        {code && typeof value === "string" ? <code>{value || "—"}</code> : value ?? "—"}
        {copyable && typeof value === "string" && value ? (
          <IconButton aria-label={copied ? "已复制" : "复制"} onClick={copy} title="复制">
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}
