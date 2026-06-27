"use client";

import { useEffect, useState } from "react";
import { User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson } from "@/lib/api";

interface Member {
  id: string;
  email: string;
  name?: string;
  roles: string[];
  allowed_kb_names: string[];
  query_count: number;
  status: string;
}

const roleLabel = (role: string) => {
  switch (role) {
    case "enterprise_admin":
    case "tenant_admin":
    case "tenant_owner":
      return "企业管理员";
    case "team_admin":
      return "团队管理员";
    case "data_admin":
      return "数据管理员";
    case "user":
    case "analyst":
    case "end_user":
      return "普通用户";
    case "viewer":
      return "只读用户";
    default:
      return role;
  }
};

export function AdminMembers() {
  const [members, setMembers] = useState<Member[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetchJson<Member[]>("/api/admin/members").then(setMembers).catch(console.error);
  }, []);

  const filtered = members.filter((m) =>
    m.email.toLowerCase().includes(query.toLowerCase()) ||
    (m.name ?? "").toLowerCase().includes(query.toLowerCase())
  );

  return (
    <>
      <Topbar title="用户管理" />

      <div className="dm-admin-content">
        <div style={{ alignItems: "center", display: "flex", gap: 12, marginBottom: 16 }}>
          <SearchInput placeholder="搜索用户..." value={query} onChange={(e) => setQuery(e.target.value)} />
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>共 {filtered.length} 位用户</span>
        </div>

        <Panel title="Users" action={<Badge tone="neutral">只读</Badge>}>
          <div className="dm-table-head dm-user-row">
            <span>用户</span>
            <span>角色</span>
            <span>可访问知识库</span>
            <span>问答数</span>
            <span>状态</span>
          </div>
          {filtered.map((user) => (
            <div className="dm-user-row" key={user.id}>
              <div className="dm-user-cell">
                <span className="dm-avatar">
                  <User size={14} />
                </span>
                <span>
                  <strong>{user.name || user.email}</strong>
                  <small>{user.email}</small>
                </span>
              </div>
              <span>{user.roles.map(roleLabel).join(", ")}</span>
              <span>{user.allowed_kb_names.join(", ") || "—"}</span>
              <span>{user.query_count}</span>
              <span>
                <Badge tone={user.status === "active" ? "success" : "neutral"}>
                  {user.status === "active" ? "启用中" : user.status}
                </Badge>
              </span>
            </div>
          ))}
          {filtered.length === 0 ? <div className="dm-empty-state">没有匹配的用户</div> : null}
        </Panel>
      </div>
    </>
  );
}
