"use client";

import { LockKeyhole, UserRound } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { BrandMark } from "@/components/ui/brand-mark";
import { acceptInvitation, authenticatedHomePath } from "@/lib/auth";

export function InviteAcceptView() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const me = await acceptInvitation(token, email, password);
      const basePath = window.location.pathname.startsWith("/documind") ? "/documind" : "";
      window.location.replace(`${basePath}${authenticatedHomePath(me.scope, me.roles)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "接受邀请失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="dm-login-page" data-tenant-tone="jade">
      <header className="dm-login-brandbar">
        <div className="dm-login-brand-identity"><BrandMark /></div>
      </header>

      <section className="dm-login-story" aria-label="租户邀请说明">
        <div className="dm-login-story-watermark" aria-hidden="true">邀</div>
        <div className="dm-login-story-copy">
          <div className="dm-login-story-kicker"><span />TENANT INVITATION</div>
          <h2><span>连接企业知识</span><strong>加入协作空间</strong></h2>
          <p>通过管理员发出的安全邀请加入租户。已有账号直接验证，新账号将自动完成注册。</p>
        </div>
      </section>

      <form className="dm-login-card" onSubmit={submit}>
        <div className="dm-login-card-heading">
          <span className="dm-login-eyebrow">接受邀请</span>
          <h1>加入租户</h1>
          <p>填写账号与密码，验证后立即进入企业知识空间。</p>
        </div>

        <label className="dm-field">
          <span>用户 ID</span>
          <span className="dm-login-input-wrap">
            <UserRound size={16} aria-hidden="true" />
            <input
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="已有或新建用户 ID"
              required
            />
          </span>
        </label>

        <label className="dm-field">
          <span>密码</span>
          <span className="dm-login-input-wrap">
            <LockKeyhole size={16} aria-hidden="true" />
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="已有账号密码；新账号至少 8 位"
              required
            />
          </span>
        </label>

        {error ? <div className="dm-login-error" role="alert">{error}</div> : null}

        <button className="dm-button primary dm-login-submit" disabled={submitting || !token} type="submit">
          {submitting ? "正在加入…" : "加入租户"}
        </button>
        <p className="dm-login-footnote">邀请链接仅限一人领取，请勿转发</p>
      </form>
    </main>
  );
}
