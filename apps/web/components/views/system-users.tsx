"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson } from "@/lib/api";

interface SystemUser {
  id: string;
  email: string;
  name?: string;
  status: string;
  tenants: string[];
  last_login_at?: string;
}

export function SystemUsers() {
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetchJson<SystemUser[]>("/api/system/users").then(setUsers).catch(console.error);
  }, []);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return users;
    return users.filter((user) =>
      [user.email, user.name ?? "", user.status, user.tenants.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(keyword)
    );
  }, [query, users]);

  return (
    <>
      <Topbar title="全局用户" />
      <div className="dm-admin-content">
        <div style={{ alignItems: "center", display: "flex", gap: 12, marginBottom: 16 }}>
          <SearchInput
            placeholder="搜索邮箱、姓名或租户..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>共 {filtered.length} 位用户</span>
        </div>
        <Panel title="Users" action={<Badge tone="neutral">只读</Badge>}>
          <div className="dm-table-head dm-system-user-row">
            <span>邮箱</span>
            <span>状态</span>
            <span>所属租户</span>
            <span>最近登录</span>
            <span>范围</span>
          </div>
          {filtered.map((u) => (
            <div className="dm-system-user-row" key={u.id}>
              <div>
                <strong>{u.email}</strong>
                <small>{u.name}</small>
              </div>
              <span>{u.status}</span>
              <span>{u.tenants.join(", ")}</span>
              <span>{u.last_login_at ? "刚刚" : "—"}</span>
              <span>系统身份</span>
            </div>
          ))}
          {filtered.length === 0 ? <div className="dm-empty-state">没有匹配的用户</div> : null}
        </Panel>
      </div>
    </>
  );
}
