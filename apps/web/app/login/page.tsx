"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LockKeyhole, UserRound } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { AgentOrb, BrandMark } from "@/components/ui/brand-mark";
import { ThemeToggle } from "@/components/ui/theme-toggle";

function LoginForm() {
  const { login } = useAuth();
  const searchParams = useSearchParams();
  const tenantSlug = searchParams.get("tenant") ?? undefined;
  const [email, setEmail] = useState("Anner");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email, password, tenantSlug);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
      setBusy(false);
    }
  };

  return (
    <form className="dm-login-card" onSubmit={handleSubmit}>
      <div className="dm-login-card-heading">
        <span className="dm-login-eyebrow">DOCUMIND WORKSPACE</span>
        <h1>欢迎回来</h1>
        <p>登录后继续探索你的企业知识。</p>
      </div>

      {tenantSlug ? (
        <div className="dm-login-tenant-hint">
          正在登录租户 <strong>{tenantSlug}</strong>
        </div>
      ) : null}

      <label className="dm-field">
        <span>账号</span>
        <span className="dm-login-input-wrap">
          <UserRound size={16} />
          <input
            autoComplete="username"
            type="text"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="请输入账号"
            required
          />
        </span>
      </label>

      <label className="dm-field">
        <span>密码</span>
        <span className="dm-login-input-wrap">
          <LockKeyhole size={16} />
          <input
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="请输入密码"
            required
          />
        </span>
      </label>

      {error ? <div className="dm-login-error" role="alert">{error}</div> : null}

      <button className="dm-button primary dm-login-submit" type="submit" disabled={busy}>
        {busy ? "登录中…" : "登录"}
      </button>

      <p className="dm-login-footnote">安全访问企业文档、引用与知识工作流</p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="dm-login-page">
      <header className="dm-login-brandbar">
        <BrandMark />
        <ThemeToggle />
      </header>

      <section className="dm-login-story" aria-label="DocuMind 产品介绍">
        <div className="dm-login-story-copy">
          <span>YOUR KNOWLEDGE, IN MOTION.</span>
          <h2>
            READ DEEPER.<br />
            FIND CONTEXT.<br />
            <strong>DECIDE WITH EVIDENCE.</strong>
          </h2>
          <p>把散落的企业文档，变成可追溯、可对话、可持续生长的知识。</p>
        </div>
        <AgentOrb size="large" />
      </section>

      <Suspense fallback={<div className="dm-login-card dm-login-card-loading">加载中…</div>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
