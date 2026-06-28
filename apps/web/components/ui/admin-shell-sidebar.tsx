"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  BrainCircuit,
  Building2,
  ClipboardList,
  Cpu,
  Database,
  FileText,
  FolderOpen,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Scissors,
  Search,
  Settings,
  Shield,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { isSuperAdminRole, isTenantAdminRole } from "@/lib/auth";
import { NavItem } from "./nav-item";

interface NavEntry {
  label: string;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
  roles: "super_admin" | "tenant_admin" | "all_admin";
}

interface NavSection {
  title: string;
  items: NavEntry[];
}

const sections: NavSection[] = [
  {
    title: "平台运维",
    items: [
      { label: "平台概览", href: "/system", icon: LayoutDashboard, exact: true, roles: "super_admin" },
      { label: "租户管理", href: "/system/tenants", icon: Building2, roles: "super_admin" },
      { label: "全局账号", href: "/system/users", icon: Users, roles: "super_admin" },
      { label: "模型服务", href: "/system/models", icon: Cpu, roles: "super_admin" },
      { label: "向量索引", href: "/system/vector-indexes", icon: Database, roles: "super_admin" },
      { label: "任务队列", href: "/system/jobs", icon: ListChecks, roles: "super_admin" },
      { label: "审计日志", href: "/system/audit", icon: ClipboardList, roles: "super_admin" },
      { label: "系统设置", href: "/system/settings", icon: Settings, roles: "super_admin" },
    ],
  },
  {
    title: "当前租户",
    items: [
      { label: "租户总览", href: "/admin", icon: LayoutDashboard, exact: true, roles: "all_admin" },
      { label: "知识库", href: "/admin/knowledge", icon: FolderOpen, roles: "all_admin" },
      { label: "文档与解析", href: "/admin/documents", icon: FileText, roles: "all_admin" },
      { label: "问答日志", href: "/admin/logs", icon: MessageSquare, roles: "all_admin" },
      { label: "成员管理", href: "/admin/members", icon: Users, roles: "all_admin" },
      { label: "权限策略", href: "/admin/permissions", icon: Shield, roles: "all_admin" },
    ],
  },
  {
    title: "知识库配置",
    items: [
      { label: "切割策略", href: "/admin/chunking", icon: Scissors, roles: "all_admin" },
      { label: "检索参数", href: "/admin/search", icon: Search, roles: "all_admin" },
      { label: "向量化绑定", href: "/admin/embedding", icon: BrainCircuit, roles: "all_admin" },
      { label: "LLM 绑定", href: "/admin/llm", icon: Cpu, roles: "all_admin" },
    ],
  },
];

function canSee(entry: NavEntry, roles: string[]) {
  if (entry.roles === "super_admin") return isSuperAdminRole(roles);
  if (entry.roles === "tenant_admin") return isSuperAdminRole(roles) || isTenantAdminRole(roles);
  return isSuperAdminRole(roles) || isTenantAdminRole(roles);
}

function isActive(pathname: string, item: NavEntry) {
  if (item.exact) return pathname === item.href || (item.href === "/admin" && pathname === "/");
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function AdminShellSidebar() {
  const pathname = usePathname();
  const { me } = useAuth();
  const roles = me?.roles ?? [];
  const homeHref = isSuperAdminRole(roles) ? "/system" : "/admin";

  return (
    <aside className="dm-admin-sidebar">
      <div className="dm-sidebar-top">
        <Link className="dm-admin-logo" href={homeHref}>
          DocuMind
        </Link>
      </div>

      <nav className="dm-nav">
        {sections.map((section) => {
          const items = section.items.filter((item) => canSee(item, roles));
          if (items.length === 0) return null;
          return (
            <div className="dm-nav-section" key={section.title}>
              <div className="dm-nav-group-title">{section.title}</div>
              {items.map((item) => (
                <NavItem key={item.href} {...item} active={isActive(pathname, item)} />
              ))}
            </div>
          );
        })}
      </nav>

      <Link className="dm-return-row" href="/chat">
        <ArrowLeft size={15} />
        <span>返回对话</span>
      </Link>
    </aside>
  );
}
