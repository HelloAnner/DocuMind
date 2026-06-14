"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    fetchJson<SystemUser[]>("/api/system/users").then(setUsers).catch(console.error);
  }, []);

  return (
    <>
      <Topbar title="全局用户" />
      <div className="dm-admin-content">
        <div style={{ alignItems: "center", display: "flex", gap: 12, marginBottom: 16 }}>
          <SearchInput placeholder="搜索邮箱或姓名..." />
        </div>
        <Panel title="Users">
          <div className="dm-table-head dm-system-user-row">
            <span>邮箱</span>
            <span>状态</span>
            <span>所属租户</span>
            <span>最近登录</span>
            <span>操作</span>
          </div>
          {users.map((u) => (
            <div className="dm-system-user-row" key={u.id}>
              <div>
                <strong>{u.email}</strong>
                <small>{u.name}</small>
              </div>
              <span>{u.status}</span>
              <span>{u.tenants.join(", ")}</span>
              <span>{u.last_login_at ? "刚刚" : "—"}</span>
              <div className="dm-row-actions">
                <button className="dm-button ghost" style={{ height: 28, padding: "0 8px", fontSize: 12 }}>查看</button>
                <button className="dm-button ghost" style={{ height: 28, padding: "0 8px", fontSize: 12, color: "var(--color-error)" }}>禁用</button>
              </div>
            </div>
          ))}
        </Panel>
      </div>
    </>
  );
}
