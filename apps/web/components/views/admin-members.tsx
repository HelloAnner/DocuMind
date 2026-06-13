"use client";

import { Plus, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { Topbar } from "@/components/ui/topbar";

const users = [
  { name: "张三", email: "zhangsan@company.com", role: "知识库管理员", kbs: "全部", count: 156, status: "启用中", joined: "2025-01-15" },
  { name: "李四", email: "lisi@company.com", role: "普通用户", kbs: "产品文档库、销售资料库", count: 89, status: "启用中", joined: "2025-02-20" },
  { name: "王五", email: "wangwu@company.com", role: "普通用户", kbs: "人力资源库", count: 34, status: "启用中", joined: "2025-03-10" },
  { name: "赵六", email: "zhaoliu@company.com", role: "普通用户", kbs: "研发规范库", count: 112, status: "待激活", joined: "2025-06-12" },
  { name: "孙七", email: "sunqi@company.com", role: "普通用户", kbs: "产品文档库", count: 8, status: "已停用", joined: "2025-04-05" },
];

export function AdminMembers() {
  return (
    <>
      <Topbar title="用户管理">
        <Button icon={<Plus size={14} />}>邀请用户</Button>
      </Topbar>

      <div className="dm-admin-content">
        <div style={{ alignItems: "center", display: "flex", gap: 12, marginBottom: 16 }}>
          <SearchInput placeholder="搜索用户..." />
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>共 24 位用户</span>
        </div>

        <Panel title="Users">
          <div className="dm-table-head dm-user-row">
            <span>用户</span>
            <span>角色</span>
            <span>可访问知识库</span>
            <span>问答数</span>
            <span>状态</span>
            <span>加入时间</span>
          </div>
          {users.map((user) => (
            <div className="dm-user-row" key={user.email}>
              <div className="dm-user-cell">
                <span className="dm-avatar">
                  <User size={14} />
                </span>
                <span>
                  <strong>{user.name}</strong>
                  <small>{user.email}</small>
                </span>
              </div>
              <span>{user.role}</span>
              <span>{user.kbs}</span>
              <span>{user.count}</span>
              <span>
                <Badge tone={user.status === "启用中" ? "success" : user.status === "待激活" ? "warning" : "neutral"}>
                  {user.status}
                </Badge>
              </span>
              <span>{user.joined}</span>
            </div>
          ))}
        </Panel>
      </div>
    </>
  );
}
