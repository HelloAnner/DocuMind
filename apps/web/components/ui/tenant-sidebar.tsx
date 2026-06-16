"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, BookOpen, Shield, Users } from "lucide-react";
import { NavItem } from "./nav-item";

const nav = [
  { label: "知识库", href: "/tenant/knowledge", icon: BookOpen },
  { label: "用户管理", href: "/tenant/members", icon: Users },
  { label: "权限策略", href: "/tenant/permissions", icon: Shield },
];

export function TenantSidebar() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/tenant") return pathname === "/tenant";
    return pathname.startsWith(href);
  };

  return (
    <aside className="dm-admin-sidebar">
      <div className="dm-sidebar-top">
        <Link className="dm-admin-logo" href="/tenant">
          DocuMind
        </Link>
      </div>

      <nav className="dm-nav">
        <div className="dm-nav-section">
          <div className="dm-nav-group-title">租户管理</div>
          {nav.map((item) => (
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
