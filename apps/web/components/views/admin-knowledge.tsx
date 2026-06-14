"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KnowledgeCard } from "@/components/ui/knowledge-card";
import { SearchInput } from "@/components/ui/search-input";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson, type KnowledgeBase } from "@/lib/api";

export function AdminKnowledge() {
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetchJson<KnowledgeBase[]>("/api/admin/knowledge-bases")
      .then(setKnowledgeBases)
      .catch(console.error);
  }, []);

  const filtered = knowledgeBases.filter((k) =>
    k.name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <>
      <Topbar title="知识库管理">
        <Button icon={<Plus size={14} />}>新建知识库</Button>
      </Topbar>

      <div className="dm-admin-content">
        <div style={{ alignItems: "center", display: "flex", gap: 12, marginBottom: 16 }}>
          <SearchInput placeholder="搜索知识库..." value={query} onChange={(e) => setQuery(e.target.value)} />
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>共 {filtered.length} 个知识库</span>
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
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
