"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson } from "@/lib/api";

interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  member_count: number;
  kb_count: number;
  doc_count: number;
  monthly_queries: number;
}

export function SystemTenants() {
  const [tenants, setTenants] = useState<Tenant[]>([]);

  useEffect(() => {
    fetchJson<Tenant[]>("/api/system/tenants").then(setTenants).catch(console.error);
  }, []);

  return (
    <>
      <Topbar title="租户管理">
        <Button icon={<Plus size={14} />}>新建租户</Button>
      </Topbar>
      <div className="dm-admin-content">
        <div style={{ alignItems: "center", display: "flex", gap: 12, marginBottom: 16 }}>
          <SearchInput placeholder="搜索租户..." />
        </div>
        <Panel title="Tenants">
          <div className="dm-table-head dm-tenant-row">
            <span>名称</span>
            <span>状态</span>
            <span>成员</span>
            <span>知识库</span>
            <span>文档数</span>
            <span>本月问答</span>
            <span>操作</span>
          </div>
          {tenants.map((t) => (
            <div className="dm-tenant-row" key={t.id}>
              <div>
                <strong>{t.name}</strong>
                <small>{t.slug}</small>
              </div>
              <span>{t.status}</span>
              <span>{t.member_count}</span>
              <span>{t.kb_count}</span>
              <span>{t.doc_count.toLocaleString()}</span>
              <span>{t.monthly_queries.toLocaleString()}</span>
              <div className="dm-row-actions">
                <button className="dm-button ghost" style={{ height: 28, padding: "0 8px", fontSize: 12 }}>详情</button>
                <button className="dm-button ghost" style={{ height: 28, padding: "0 8px", fontSize: 12, color: "var(--color-error)" }}>停用</button>
              </div>
            </div>
          ))}
        </Panel>
      </div>
    </>
  );
}
