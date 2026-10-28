"use client";

import { clsx } from "clsx";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return <span className={clsx("dm-badge", tone, className)}>{children}</span>;
}
