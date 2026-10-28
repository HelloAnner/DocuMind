"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/providers/auth-provider";
import { BrandMark } from "@/components/ui/brand-mark";
import {
  acceptInvitation,
  AUTHENTICATED_HOME_PATH,
  INVITATION_STORAGE_KEY,
  validateInvitation,
  type InvitationValidation,
} from "@/lib/auth";

export function InviteAcceptView() {
  const { me, loading } = useAuth();
  const [token, setToken] = useState("");
  const [details, setDetails] = useState<InvitationValidation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const hashToken = new URLSearchParams(window.location.hash.slice(1)).get("token");
    const storedToken = sessionStorage.getItem(INVITATION_STORAGE_KEY);
    const nextToken = hashToken || storedToken || "";
    if (hashToken) {
      sessionStorage.setItem(INVITATION_STORAGE_KEY, hashToken);
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    setToken(nextToken);
    if (!nextToken) {
      setError("邀请链接无效");
      return;
    }
    validateInvitation(nextToken)
      .then(setDetails)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "邀请链接无效"));
  }, []);

  const accept = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await acceptInvitation(token);
      sessionStorage.removeItem(INVITATION_STORAGE_KEY);
      const basePath = window.location.pathname.startsWith("/documind") ? "/documind" : "";
      window.location.replace(`${basePath}${AUTHENTICATED_HOME_PATH}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "接受邀请失败");
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
          <p>邀请只为已注册账号增加租户成员关系，不会创建账号或修改现有成员角色。</p>
        </div>
      </section>
      <section className="dm-login-card">
        <div className="dm-login-card-heading">
          <span className="dm-login-eyebrow">接受邀请</span>
          <h1>{details?.tenant.name ?? "加入租户"}</h1>
          <p>
            {details?.invitee_hint
              ? `受邀账号：${details.invitee_hint}`
              : "首位租户所有者邀请"}
          </p>
        </div>
        {details ? (
          <div className="dm-login-footnote">
            角色：{details.roles.join("、")} · 有效期至 {new Date(details.expires_at).toLocaleString()}
          </div>
        ) : null}
        {error ? <div className="dm-login-error" role="alert">{error}</div> : null}
        {!loading && !me ? (
          <>
            <Link className="dm-button primary dm-login-submit" href="/login">登录后确认</Link>
            <Link className="dm-login-footnote" href="/register">没有账号？先注册</Link>
          </>
        ) : (
          <button
            className="dm-button primary dm-login-submit"
            disabled={submitting || !details || !token}
            onClick={accept}
            type="button"
          >
            {submitting ? "正在加入…" : "确认加入租户"}
          </button>
        )}
        <p className="dm-login-footnote">邀请令牌仅使用一次，请勿转发</p>
      </section>
    </main>
  );
}
