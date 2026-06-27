"use client";

import { useEffect, useState } from "react";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson } from "@/lib/api";

interface AuditEvent {
  id: string;
  time: string;
  tenant: string;
  user: string;
  action: string;
  resource: string;
  ip: string;
}

export function SystemAudit() {
  const [query, setQuery] = useState("");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const qs = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
    setLoading(true);
    fetchJson<AuditEvent[]>(`/api/system/audit${qs}`)
      .then(setEvents)
      .catch((error) => {
        console.error(error);
        setEvents([]);
      })
      .finally(() => setLoading(false));
  }, [query]);

  const filtered = events.filter(
    (e) =>
      e.user.toLowerCase().includes(query.toLowerCase()) ||
      e.action.toLowerCase().includes(query.toLowerCase()) ||
      e.resource.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <>
      <Topbar title="审计日志" />
      <div className="dm-admin-content">
        <div className="dm-filter-bar">
          <SearchInput
            placeholder="搜索用户、动作或资源..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <Panel title="Events">
          <div className="dm-table-head dm-audit-row">
            <span>时间</span>
            <span>租户</span>
            <span>用户</span>
            <span>动作</span>
            <span>资源</span>
            <span>IP</span>
          </div>
          {loading ? <div className="dm-empty-state">加载审计日志中...</div> : null}
          {!loading && filtered.map((e) => (
            <div className="dm-audit-row" key={e.id}>
              <span>{new Date(e.time).toLocaleString()}</span>
              <span>{e.tenant}</span>
              <span>{e.user}</span>
              <span>{e.action}</span>
              <span>{e.resource}</span>
              <span>{e.ip}</span>
            </div>
          ))}
          {!loading && filtered.length === 0 ? <div className="dm-empty-state">暂无审计日志</div> : null}
        </Panel>
      </div>
    </>
  );
}
