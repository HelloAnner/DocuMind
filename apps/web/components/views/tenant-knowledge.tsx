"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { KnowledgeCard } from "@/components/ui/knowledge-card";
import { SearchInput } from "@/components/ui/search-input";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson, type KnowledgeBase } from "@/lib/api";
import { useAuth } from "@/components/providers/auth-provider";

export function TenantKnowledge() {
  const { me } = useAuth();
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");

  useEffect(() => {
    fetchJson<KnowledgeBase[]>("/api/admin/knowledge-bases")
      .then(setKnowledgeBases)
      .catch(console.error);
  }, []);

  const tenantName = me?.tenant?.name ?? "当前租户";

  const filtered = knowledgeBases.filter((k) => {
    const matchesQuery = k.name.toLowerCase().includes(query.toLowerCase());
    const matchesStatus = status === "all" || k.status === status;
    return matchesQuery && matchesStatus;
  });

  return (
    <>
      <Topbar title={`${tenantName} / 知识库`}>
        <Badge tone="neutral">只读</Badge>
      </Topbar>

      <div className="dm-admin-content">
        <div className="dm-filter-bar">
          <SearchInput
            placeholder="搜索知识库"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="dm-select"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">状态 ▾</option>
            <option value="active">启用中</option>
            <option value="inactive">已停用</option>
            <option value="indexing">索引中</option>
          </select>
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
          {filtered.map((kb) => (
            <KnowledgeCard
              key={kb.id}
              name={kb.name}
              desc={kb.description ?? ""}
              docs={kb.doc_count}
              chunks={kb.chunk_count}
            />
          ))}
        </div>
      </div>
    </>
  );
}
