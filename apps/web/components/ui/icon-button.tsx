"use client";

import { clsx } from "clsx";

export function IconButton({
  children,
  className,
  ...props
}: {
  children: React.ReactNode;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={clsx("dm-icon-button", className)} {...props}>
      {children}
    </button>
  );
}
