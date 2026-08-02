"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { acceptInvitation, AUTHENTICATED_HOME_PATH } from "@/lib/auth";
import { Button } from "@/components/ui/button";

export function InviteAcceptView() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await acceptInvitation(token, email, password);
      router.replace(AUTHENTICATED_HOME_PATH);
    } catch (err) {
      setError(err instanceof Error ? err.message : "接受邀请失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="dm-login-page">
      <section className="dm-login-card">
        <div className="dm-login-brand">DocuMind</div>
        <h1>接受邀请</h1>
        <p>已有账号直接验证登录；新账号将自动注册并加入租户。</p>
        <label>
          <span>账号</span>
          <input autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="已有账号或新邮箱" />
        </label>
        <label>
          <span>密码</span>
          <input
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="已有账号密码；新账号至少 8 位"
          />
        </label>
        {error ? <div className="dm-login-error">{error}</div> : null}
        <Button disabled={submitting || !token || !email.trim() || !password} onClick={submit}>
          加入租户
        </Button>
      </section>
    </main>
  );
}
