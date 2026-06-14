"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/providers/auth-provider";
import { type UserRole } from "@/lib/auth";

const roles: { value: UserRole; label: string }[] = [
  { value: "super_admin", label: "超级管理员" },
  { value: "tenant_admin", label: "租户管理员" },
  { value: "end_user", label: "普通用户" },
  { value: "viewer", label: "只读用户" },
];

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState("dev@documind.local");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("tenant_admin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email, role);
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
            placeholder="••••••••"
          />
        </div>

        <div className="dm-field">
          <label>角色（开发模拟）</label>
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        {error && <div className="dm-login-error">{error}</div>}

        <button className="dm-button primary" type="submit" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </main>
  );
}
