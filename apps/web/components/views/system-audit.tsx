"use client";

import { useState } from "react";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { Topbar } from "@/components/ui/topbar";

interface AuditEvent {
  id: string;
  time: string;
  tenant: string;
  user: string;
  action: string;
  resource: string;
  ip: string;
}

const mockEvents: AuditEvent[] = [
  {
    id: "1",
    time: "2025-06-16 10:42:18",
    tenant: "acme",
    user: "zhang@corp.com",
    action: "chat.ask",
    resource: "conv_8821",
    ip: "10.0.4.12",
  },
  {
    id: "2",
    time: "2025-06-16 10:38:05",
    tenant: "acme",
    user: "admin@acme.com",
    action: "document.upload",
    resource: "doc_3391",
    ip: "10.0.4.9",
  },
  {
    id: "3",
    time: "2025-06-16 10:15:33",
    tenant: "beta",
    user: "li@beta.com",
    action: "kb.create",
    resource: "kb_4412",
    ip: "10.0.7.22",
  },
  {
    id: "4",
    time: "2025-06-16 09:58:12",
    tenant: "acme",
    user: "system",
    action: "job.retry",
    resource: "job_1205",
    ip: "127.0.0.1",
  },
];

export function SystemAudit() {
  const [query, setQuery] = useState("");

  const filtered = mockEvents.filter(
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
          {filtered.map((e) => (
            <div className="dm-audit-row" key={e.id}>
              <span>{e.time}</span>
              <span>{e.tenant}</span>
              <span>{e.user}</span>
              <span>{e.action}</span>
              <span>{e.resource}</span>
              <span>{e.ip}</span>
            </div>
          ))}
        </Panel>
      </div>
    </>
  );
}
