"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { acceptInvitation, defaultRouteForRole } from "@/lib/auth";
import { Button } from "@/components/ui/button";

export function InviteAcceptView() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const me = await acceptInvitation(token, name, password);
      router.replace(defaultRouteForRole(me.roles[0] ?? "user"));
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
        <p>设置账号信息后即可加入当前租户。</p>
        <label>
          <span>姓名</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="你的姓名" />
        </label>
        <label>
          <span>密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="至少 8 个字符"
          />
        </label>
        {error ? <div className="dm-login-error">{error}</div> : null}
        <Button disabled={submitting || !token || password.length < 8} onClick={submit}>
          加入租户
        </Button>
      </section>
    </main>
  );
}
