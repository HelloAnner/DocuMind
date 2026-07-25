"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/components/providers/auth-provider";

function LoginForm() {
  const { login } = useAuth();
  const searchParams = useSearchParams();
  const tenantSlug = searchParams.get("tenant") ?? undefined;
  const [email, setEmail] = useState("Anner");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
      <div className="dm-login-card-title">登录 DocuMind</div>

      {tenantSlug ? (
        <div className="dm-login-tenant-hint">
          正在登录租户 <strong>{tenantSlug}</strong>
        </div>
      ) : null}

      <div className="dm-field">
        <label>账号</label>
        <input
          type="text"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Anner"
          required
        />
      </div>

      <div className="dm-field">
        <label>密码</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="请输入密码"
          required
        />
      </div>

      {error && <div className="dm-login-error">{error}</div>}

      <button className="dm-button primary" type="submit" disabled={busy}>
        {busy ? "登录中…" : "登录"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="dm-login-page">
      <div className="dm-login-hero">
        <div className="dm-login-glow" />
        <h1>DocuMind</h1>
        <p>向你的文档提问，获取精准答案</p>
      </div>

      <Suspense fallback={<form className="dm-login-card" />}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
