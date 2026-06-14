"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import Link from "next/link";
import { fetchJson } from "@/lib/api";
import type { Conversation } from "@/lib/types";

function groupByDate(items: Conversation[]) {
  const groups = new Map<string, Conversation[]>();
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();

  for (const item of items) {
    const d = new Date(item.updated_at).toDateString();
    let key = d;
    if (d === today) key = "今天";
    else if (d === yesterday) key = "昨天";
    else key = new Date(item.updated_at).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  return groups;
}

export default function HistoryPage() {
  const [history, setHistory] = useState<Conversation[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetchJson<{ items: Conversation[] }>("/api/history?limit=50")
      .then((res) => setHistory(res.items))
      .catch(console.error);
  }, []);

  const filtered = history.filter((h) =>
    (h.title || "").toLowerCase().includes(query.toLowerCase())
  );
  const groups = groupByDate(filtered);

  return (
    <main className="dm-public-page">
      <header className="dm-public-topbar">
        <h1>历史问答</h1>
        <div className="dm-search-input" style={{ width: 320 }}>
          <Search size={14} />
          <input
            placeholder="搜索历史..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </header>

      <div className="dm-public-content">
        {Array.from(groups.entries()).map(([label, items]) => (
          <div className="dm-history-group" key={label}>
            <div className="dm-history-group-title">{label}</div>
            {items.map((item) => (
              <Link className="dm-history-item-row" href={`/chat/${item.conversation_id}`} key={item.conversation_id}>
                {item.title}
              </Link>
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <p style={{ color: "var(--text-muted)" }}>暂无历史问答。</p>
        )}
      </div>
    </main>
  );
}
