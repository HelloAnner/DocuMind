"use client";

import { useEffect, useState } from "react";
import { Eye, MessageSquareText } from "lucide-react";
import { AnswerContent } from "@/components/chat/answer-content";
import { BrandMark } from "@/components/ui/brand-mark";
import { getSharedConversation, type SharedConversation } from "@/lib/api";

export default function ShareClientPage() {
  const [share, setShare] = useState<SharedConversation | null>(null);
  const [error, setError] = useState("");
  const [token, setToken] = useState("");

  useEffect(() => {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const shareIndex = parts.indexOf("s");
    setToken(shareIndex >= 0 ? decodeURIComponent(parts[shareIndex + 1] || "") : "");
  }, []);

  useEffect(() => {
    if (!token) return;
    let active = true;
    getSharedConversation(token)
      .then((result) => { if (active) setShare(result); })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "分享加载失败");
      });
    return () => { active = false; };
  }, [token]);

  if (error) {
    return (
      <main className="dm-public-share">
        <div className="dm-public-share-state">
          <div><BrandMark /><h1>分享不存在或已失效</h1><p>{error}</p></div>
        </div>
      </main>
    );
  }

  if (!share) {
    return (
      <main className="dm-public-share">
        <div className="dm-public-share-state"><BrandMark /><span>正在加载分享内容…</span></div>
      </main>
    );
  }

  return (
    <main className="dm-public-share">
      <div className="dm-public-share-shell">
        <header className="dm-public-share-header">
          <BrandMark />
          <span className="dm-public-share-meta"><Eye size={13} aria-hidden="true" /> {share.view_count} 次查看</span>
        </header>
        <article className="dm-public-share-card">
          <header className="dm-public-share-title">
            <h1>{share.title}</h1>
            <p>只读会话分享 · {formatDate(share.created_at)}</p>
          </header>
          <div className="dm-public-share-messages">
            {share.messages.map((message) => (
              <section className={`dm-public-share-message ${message.role}`} key={message.message_id}>
                <header>
                  <MessageSquareText size={14} aria-hidden="true" />
                  {message.role === "user" ? "提问" : "DocuMind 回答"}
                </header>
                <div className="dm-public-share-content">
                  {message.role === "assistant"
                    ? <AnswerContent content={message.content} />
                    : message.content}
                </div>
                {message.citations.length > 0 ? (
                  <details className="dm-public-share-sources">
                    <summary>查看 {message.citations.length} 条引用依据</summary>
                    <ol>
                      {message.citations.map((citation) => (
                        <li key={citation.citation_id}>
                          <strong>[{citation.index}] {citation.doc_title}</strong>
                          <blockquote>{citation.quote}</blockquote>
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              </section>
            ))}
          </div>
          <footer className="dm-public-share-footer">此页面由 DocuMind 生成，仅展示分享时的会话内容。</footer>
        </article>
      </div>
    </main>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
