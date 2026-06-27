"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
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
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetchJson<Tenant[]>("/api/system/tenants").then(setTenants).catch(console.error);
  }, []);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return tenants;
    return tenants.filter((tenant) =>
      [tenant.name, tenant.slug, tenant.status, tenant.plan]
        .join(" ")
        .toLowerCase()
        .includes(keyword)
    );
  }, [query, tenants]);

  return (
    <>
      <Topbar title="租户管理" />
      <div className="dm-admin-content">
        <div style={{ alignItems: "center", display: "flex", gap: 12, marginBottom: 16 }}>
          <SearchInput
            placeholder="搜索租户、Slug 或套餐..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>共 {filtered.length} 个租户</span>
        </div>
        <Panel title="Tenants" action={<Badge tone="neutral">只读</Badge>}>
          <div className="dm-table-head dm-tenant-row">
            <span>名称</span>
            <span>状态</span>
            <span>成员</span>
            <span>知识库</span>
            <span>文档数</span>
            <span>本月问答</span>
            <span>套餐</span>
          </div>
          {filtered.map((t) => (
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
              <span>{t.plan}</span>
            </div>
          ))}
          {filtered.length === 0 ? <div className="dm-empty-state">没有匹配的租户</div> : null}
        </Panel>
      </div>
    </>
  );
}
