"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  Building2,
  ClipboardList,
  Cpu,
  Database,
  LayoutDashboard,
  ListChecks,
  Settings,
  Users,
} from "lucide-react";
import { NavItem } from "./nav-item";

const nav = [
  { label: "概览", href: "/system", icon: LayoutDashboard },
  { label: "租户", href: "/system/tenants", icon: Building2 },
  { label: "用户", href: "/system/users", icon: Users },
  { label: "模型服务", href: "/system/models", icon: Cpu },
  { label: "向量索引", href: "/system/vector-indexes", icon: Database },
  { label: "任务队列", href: "/system/jobs", icon: ListChecks },
  { label: "审计", href: "/system/audit", icon: ClipboardList },
  { label: "系统设置", href: "/system/settings", icon: Settings },
];

export function SystemSidebar() {
  const pathname = usePathname();
  const isActive = (href: string) => {
    if (href === "/system") return pathname === "/system";
    return pathname.startsWith(href);
  };

  return (
    <aside className="dm-system-sidebar">
      <div className="dm-sidebar-top">
        <Link className="dm-admin-logo" href="/system">
          DocuMind / System
        </Link>
      </div>

      <nav className="dm-nav">
        <div className="dm-nav-section">
          {nav.map((item) => (
            <NavItem key={item.href} {...item} active={isActive(item.href)} />
          ))}
        </div>
      </nav>

      <Link className="dm-return-row" href="/chat">
        <ArrowLeft size={15} />
        <span>返回工作台</span>
      </Link>
    </aside>
  );
}
