"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  BrainCircuit,
  Cpu,
  FileText,
  LayoutDashboard,
  MessageSquare,
  Scissors,
  Search,
  Users,
} from "lucide-react";
import { NavItem } from "./nav-item";

const manageNav = [
  { label: "概览", href: "/admin", icon: LayoutDashboard },
  { label: "知识库", href: "/admin/knowledge", icon: BookOpen },
  { label: "文档管理", href: "/admin/documents", icon: FileText },
  { label: "问答日志", href: "/admin/logs", icon: MessageSquare },
  { label: "用户管理", href: "/admin/members", icon: Users },
];

const configNav = [
  { label: "切割策略", href: "/admin/chunking", icon: Scissors },
  { label: "向量化模型", href: "/admin/embedding", icon: BrainCircuit },
  { label: "检索参数", href: "/admin/search", icon: Search },
  { label: "LLM 服务商", href: "/admin/llm", icon: Cpu },
];

export function AdminSidebar() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/admin") {
      return pathname === "/admin" || pathname === "/";
    }
    return pathname === href;
  };

  return (
    <aside className="dm-admin-sidebar">
      <div className="dm-sidebar-top">
        <Link className="dm-admin-logo" href="/admin">
          DocuMind
        </Link>
      </div>

      <nav className="dm-nav">
        <div className="dm-nav-section">
          <div className="dm-nav-group-title">管理</div>
          {manageNav.map((item) => (
            <NavItem key={item.href} {...item} active={isActive(item.href)} />
          ))}
        </div>
        <div className="dm-nav-section">
          <div className="dm-nav-group-title">系统配置</div>
          {configNav.map((item) => (
            <NavItem key={item.href} {...item} active={isActive(item.href)} />
          ))}
        </div>
      </nav>

      <Link className="dm-return-row" href="/chat">
        <ArrowLeft size={15} />
        <span>返回对话</span>
      </Link>
    </aside>
  );
}
