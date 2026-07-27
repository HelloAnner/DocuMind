"use client";

import Link from "next/link";
import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";

export function NavItem({
  href,
  icon: Icon,
  label,
  active,
  badge,
  onClick,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  active?: boolean;
  badge?: string;
  onClick?: () => void;
}) {
  return (
    <Link className={clsx("dm-nav-item", active && "active")} href={href} onClick={onClick}>
      <Icon size={16} />
      <span>{label}</span>
      {badge ? <span className="dm-badge neutral">{badge}</span> : null}
    </Link>
  );
}
