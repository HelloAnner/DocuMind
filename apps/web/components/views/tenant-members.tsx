"use client";

import { useEffect, useState } from "react";
import { Plus, User } from "lucide-react";
import { Button } from "@/components/ui/button";
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
    case "tenant_owner":
      return "租户管理员";
    case "tenant_admin":
      return "租户管理员";
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

export function TenantMembers() {
  const [members, setMembers] = useState<Member[]>([]);
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("all");
  const [status, setStatus] = useState("all");
  const [kbPermission, setKbPermission] = useState("all");

  useEffect(() => {
    fetchJson<Member[]>("/api/admin/members").then(setMembers).catch(console.error);
  }, []);

  const filtered = members.filter((m) => {
    const matchesQuery =
      m.email.toLowerCase().includes(query.toLowerCase()) ||
      (m.name ?? "").toLowerCase().includes(query.toLowerCase());
    const matchesRole = role === "all" || m.roles.includes(role);
    const matchesStatus = status === "all" || m.status === status;
    const matchesKb =
      kbPermission === "all" ||
      (kbPermission === "all_kbs" && m.allowed_kb_names.length === 0) ||
      m.allowed_kb_names.some((n) => n.includes(kbPermission));
    return matchesQuery && matchesRole && matchesStatus && matchesKb;
  });

  return (
    <>
      <Topbar title="用户管理">
        <Button icon={<Plus size={14} />}>+ 邀请用户</Button>
      </Topbar>

      <div className="dm-admin-content">
        <div className="dm-filter-bar">
          <SearchInput placeholder="搜索" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className="dm-select" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="all">角色 ▾</option>
            <option value="tenant_admin">租户管理员</option>
            <option value="user">普通用户</option>
            <option value="viewer">只读用户</option>
          </select>
          <select className="dm-select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">状态 ▾</option>
            <option value="active">启用中</option>
            <option value="inactive">已停用</option>
          </select>
          <select
            className="dm-select"
            value={kbPermission}
            onChange={(e) => setKbPermission(e.target.value)}
          >
            <option value="all">知识库权限 ▾</option>
            <option value="all_kbs">全部</option>
            <option value="产品文档库">产品文档库</option>
            <option value="销售资料库">销售资料库</option>
            <option value="人力资源库">人力资源库</option>
            <option value="研发规范库">研发规范库</option>
          </select>
        </div>

        <Panel title="Users">
          <div className="dm-table-head dm-user-row">
            <span>用户</span>
            <span>角色</span>
            <span>可访问知识库</span>
            <span>问答数</span>
            <span>状态</span>
            <span>操作</span>
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
              <span>{user.allowed_kb_names.join(", ") || "全部"}</span>
              <span>{user.query_count}</span>
              <span>
                <Badge tone={user.status === "active" ? "success" : "neutral"}>
                  {user.status === "active" ? "启用中" : user.status}
                </Badge>
              </span>
              <div className="dm-row-actions">
                <button className="dm-button ghost" style={{ height: 28, padding: "0 8px", fontSize: 12 }}>
                  编辑
                </button>
                <button
                  className="dm-button ghost"
                  style={{ height: 28, padding: "0 8px", fontSize: 12, color: "var(--color-error)" }}
                >
                  禁用
                </button>
              </div>
            </div>
          ))}
        </Panel>
      </div>
    </>
  );
}
