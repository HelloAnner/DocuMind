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
import { NavItem } from "./nav-item";
import { UserAccountMenu } from "./user-account-menu";

interface NavEntry {
  label: string;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
}

interface NavSection {
  title: string;
  items: NavEntry[];
}

const platformSections: NavSection[] = [
  {
    title: "平台治理",
    items: [
      { label: "运行总览", href: "/system", icon: LayoutDashboard, exact: true },
      { label: "租户管理", href: "/system/tenants", icon: Building2 },
      { label: "全局账号", href: "/system/users", icon: Users },
    ],
  },
  {
    title: "基础设施",
    items: [
      { label: "模型服务", href: "/system/models", icon: Cpu },
      { label: "向量索引", href: "/system/vector-indexes", icon: Database },
      { label: "任务队列", href: "/system/jobs", icon: ListChecks },
      { label: "平台审计", href: "/system/audit", icon: ClipboardList },
      { label: "系统设置", href: "/system/settings", icon: Settings },
    ],
  },
];

const tenantSections: NavSection[] = [
  {
    title: "租户工作台",
    items: [
      { label: "租户总览", href: "/admin", icon: LayoutDashboard, exact: true },
      { label: "知识库", href: "/admin/knowledge", icon: FolderOpen },
      { label: "文档与解析", href: "/admin/documents", icon: FileText },
      { label: "问答日志", href: "/admin/logs", icon: MessageSquare },
      { label: "成员与邀请", href: "/admin/members", icon: Users },
      { label: "访问权限", href: "/admin/permissions", icon: Shield },
    ],
  },
  {
    title: "知识库配置",
    items: [
      { label: "切割策略", href: "/admin/chunking", icon: Scissors },
      { label: "检索参数", href: "/admin/search", icon: Search },
      { label: "向量化绑定", href: "/admin/embedding", icon: BrainCircuit },
      { label: "LLM 绑定", href: "/admin/llm", icon: Cpu },
    ],
  },
];

function isActive(pathname: string, item: NavEntry) {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function AdminShellSidebar() {
  const pathname = usePathname();
  const isPlatform = pathname.startsWith("/system");
  const sections = isPlatform ? platformSections : tenantSections;
  const homeHref = isPlatform ? "/system" : "/admin";

  return (
    <aside className="dm-admin-sidebar">
      <div className="dm-sidebar-top">
        <Link className="dm-admin-logo" href={homeHref}>
          DocuMind
        </Link>
      </div>

      <nav className="dm-nav">
        {sections.map((section) => (
          <div className="dm-nav-section" key={section.title}>
            <div className="dm-nav-group-title">{section.title}</div>
            {section.items.map((item) => (
              <NavItem key={item.href} {...item} active={isActive(pathname, item)} />
            ))}
          </div>
        ))}
      </nav>

      {!isPlatform ? (
        <Link className="dm-return-row" href="/chat">
          <ArrowLeft size={15} />
          <span>返回知识问答</span>
        </Link>
      ) : null}
      <UserAccountMenu />
    </aside>
  );
}
