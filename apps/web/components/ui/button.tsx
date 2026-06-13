"use client";

import type { ReactNode } from "react";
import { clsx } from "clsx";

export type ButtonVariant = "primary" | "secondary" | "ghost";

export function Button({
  children,
  variant = "primary",
  icon,
  className,
  ...props
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  icon?: ReactNode;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={clsx("dm-button", variant, className)} {...props}>
      {icon ? <span className="dm-button-icon">{icon}</span> : null}
      {children}
    </button>
  );
}
