"use client";

import Link from "next/link";
import { LockKeyhole, UserRound } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/providers/auth-provider";
import { BrandMark } from "@/components/ui/brand-mark";

export default function RegisterPage() {
  const { register } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirmation) {
      setError("两次输入的密码不一致");
      return;
    }
    if (new TextEncoder().encode(password).length > 72) {
      setError("密码不能超过 72 字节");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await register(username, password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "注册失败");
      setBusy(false);
    }
  };

  return (
    <main className="dm-login-page">
      <header className="dm-login-brandbar"><BrandMark /></header>
      <section className="dm-login-story" aria-label="DocuMind 注册介绍">
        <div className="dm-login-story-copy">
          <div className="dm-login-story-kicker"><span />开始使用 DocuMind</div>
          <h2><span>创建你的</span><strong>企业知识空间</strong></h2>
          <p>先创建个人账号，再创建或加入企业租户。一个账号可以在多个租户间安全切换。</p>
        </div>
      </section>
      <form className="dm-login-card" onSubmit={submit}>
        <div className="dm-login-card-heading">
          <span className="dm-login-eyebrow">开放注册</span>
          <h1>创建账号</h1>
          <p>用户名全局唯一，注册后继续创建企业空间。</p>
        </div>
        <label className="dm-field"><span>用户名</span><span className="dm-login-input-wrap">
          <UserRound size={16} /><input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
        </span></label>
        <label className="dm-field"><span>密码</span><span className="dm-login-input-wrap">
          <LockKeyhole size={16} /><input autoComplete="new-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </span></label>
        <label className="dm-field"><span>确认密码</span><span className="dm-login-input-wrap">
          <LockKeyhole size={16} /><input autoComplete="new-password" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />
        </span></label>
        {error ? <div className="dm-login-error" role="alert">{error}</div> : null}
        <button className="dm-button primary dm-login-submit" disabled={busy} type="submit">{busy ? "注册中…" : "注册"}</button>
        <p className="dm-login-footnote">已有账号？<Link href="/login">返回登录</Link></p>
      </form>
    </main>
  );
}
