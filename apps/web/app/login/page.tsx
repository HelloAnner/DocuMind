"use client";

import { useState } from "react";
import { useAuth } from "@/components/providers/auth-provider";

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("admin@documind.local");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
      setBusy(false);
    }
  };

  return (
    <main className="dm-login-page">
      <div className="dm-login-hero">
        <div className="dm-login-glow" />
        <h1>DocuMind</h1>
        <p>向你的文档提问，获取精准答案</p>
      </div>

      <form className="dm-login-card" onSubmit={handleSubmit}>
        <div className="dm-login-card-title">登录到你的工作空间</div>

        <div className="dm-field">
          <label>邮箱</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            required
          />
        </div>

        <div className="dm-field">
          <label>密码</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="默认密码 documind123"
            required
          />
        </div>

        {error && <div className="dm-login-error">{error}</div>}

        <button className="dm-button primary" type="submit" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </main>
  );
}
