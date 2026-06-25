"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  Building2,
  ClipboardList,
  Cpu,
  Database,
  FileText,
  FolderOpen,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Settings,
  Users,
} from "lucide-react";
import { NavItem } from "./nav-item";

const systemNav = [
  { label: "概览", href: "/system", icon: LayoutDashboard },
  { label: "租户", href: "/system/tenants", icon: Building2 },
  { label: "用户", href: "/system/users", icon: Users },
  { label: "模型服务", href: "/system/models", icon: Cpu },
  { label: "向量索引", href: "/system/vector-indexes", icon: Database },
  { label: "任务队列", href: "/system/jobs", icon: ListChecks },
  { label: "审计", href: "/system/audit", icon: ClipboardList },
  { label: "系统设置", href: "/system/settings", icon: Settings },
];

const knowledgeNav = [
  { label: "知识库", href: "/admin/knowledge", icon: FolderOpen },
  { label: "文档管理", href: "/admin/documents", icon: FileText },
  { label: "问答日志", href: "/admin/logs", icon: MessageSquare },
  { label: "用户管理", href: "/admin/members", icon: Users },
];

export function SystemSidebar() {
  const pathname = usePathname();
  const isActive = (href: string) => {
    if (href === "/system") return pathname === "/system";
    return pathname === href || pathname.startsWith(`${href}/`);
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
          <div className="dm-nav-group-title">系统</div>
          {systemNav.map((item) => (
            <NavItem key={item.href} {...item} active={isActive(item.href)} />
          ))}
        </div>

        <div className="dm-nav-section">
          <div className="dm-nav-group-title">知识库后台</div>
          {knowledgeNav.map((item) => (
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
