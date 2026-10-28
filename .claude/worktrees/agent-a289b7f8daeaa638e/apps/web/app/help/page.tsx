"use client";

import { BookOpen, Compass, Files, MessageCircle, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/components/providers/auth-provider";

const ITEMS = [
  { icon: MessageCircle, title: "开始问答", text: "在对话页输入问题，系统会检索当前租户有权访问的文档并生成带来源的回答。" },
  { icon: Files, title: "知识库", text: "企业管理员可上传文档、查看解析状态，并维护团队共享的知识内容。" },
  { icon: UserRound, title: "个人设置", text: "从左下角用户菜单修改展示名称和头像，保存后会同步到账号菜单和对话。" },
  { icon: BookOpen, title: "使用建议", text: "问题中明确文档、主题和时间范围，可以获得更准确、可复核的回答。" },
];

export default function HelpPage() {
  const router = useRouter();
  const { loading, me } = useAuth();

  useEffect(() => {
    if (!loading && !me) router.replace("/login");
  }, [loading, me, router]);

  if (loading || !me) return null;

  return (
    <main style={{ background: "var(--bg-primary)", minHeight: "100vh", padding: "48px clamp(24px, 5vw, 72px)" }}>
      <header style={{ marginBottom: 32, maxWidth: 760 }}>
        <div style={{ alignItems: "center", color: "var(--text-muted)", display: "flex", fontSize: 13, gap: 10, marginBottom: 12 }}>
          <Compass size={17} /> 探索
        </div>
        <h1 style={{ color: "var(--text-primary)", fontSize: 28, fontWeight: 650, letterSpacing: -0.6, margin: 0 }}>探索 DocuMind</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, lineHeight: 1.7, margin: "10px 0 0" }}>从使用文档开始，了解常用功能和提问方式。</p>
      </header>
      <section style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", maxWidth: 920 }}>
        {ITEMS.map(({ icon: Icon, title, text }) => (
          <article key={title} style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-subtle)", borderRadius: 16, padding: 20 }}>
            <div style={{ alignItems: "center", background: "var(--bg-tertiary)", borderRadius: 10, color: "var(--text-secondary)", display: "flex", height: 36, justifyContent: "center", marginBottom: 16, width: 36 }}>
              <Icon size={18} />
            </div>
            <h2 style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 600, margin: 0 }}>{title}</h2>
            <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.7, margin: "8px 0 0" }}>{text}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
