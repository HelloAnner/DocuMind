"use client";

import type { ReactNode } from "react";
import { clsx } from "clsx";

export function Panel({
  children,
  className,
  title,
  action,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  action?: ReactNode;
}) {
  return (
    <section className={clsx("dm-panel", className)}>
      {(title || action) && (
        <div className="dm-panel-head">
          {title && <div className="dm-panel-title">{title}</div>}
          {action && <div className="dm-panel-action">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
