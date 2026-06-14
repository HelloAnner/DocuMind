"use client";

import { useEffect, useState } from "react";
import { MessageSquare, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchJson } from "@/lib/api";
import Link from "next/link";

interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  doc_count: number;
  updated_at: string;
}

export default function KnowledgePage() {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetchJson<KnowledgeBase[]>("/api/knowledge-bases").then(setKbs).catch(console.error);
  }, []);

  const filtered = kbs.filter((k) => k.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <main className="dm-public-page">
      <header className="dm-public-topbar">
        <h1>我可访问的知识库</h1>
        <div className="dm-search-input" style={{ width: 280 }}>
          <Search size={14} />
          <input
            placeholder="搜索知识库..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </header>

      <div className="dm-public-content">
        {filtered.map((kb) => (
          <div className="dm-knowledge-public-row" key={kb.id}>
            <div>
              <strong>{kb.name}</strong>
              <p>{kb.description}</p>
            </div>
            <div className="dm-knowledge-public-meta">
              <span>{kb.doc_count} 文档</span>
              <span>最近更新 {new Date(kb.updated_at).toLocaleDateString()}</span>
              <Link href={`/chat?kb=${kb.id}`}>
                <Button icon={<MessageSquare size={14} />}>开始提问</Button>
              </Link>
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <p style={{ color: "var(--text-muted)" }}>暂无可访问的知识库。</p>
        )}
      </div>
    </main>
  );
}
