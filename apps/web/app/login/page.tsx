"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Building2, LockKeyhole, UserRound } from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/auth-provider";
import { AgentOrb, BrandMark } from "@/components/ui/brand-mark";
import { getTenantLoginContext, type TenantLoginContext } from "@/lib/auth";
import { createTenantLoginProfile, type TenantLoginProfile } from "./tenant-login-profile";

type TenantContextState =
  | { status: "ready"; context: TenantLoginContext | null }
  | { status: "loading"; context: null }
  | { status: "error"; context: null; message: string };

function LoginForm({
  profile,
  tenantSlug,
  tenantState,
}: {
  profile: TenantLoginProfile;
  tenantSlug?: string;
  tenantState: TenantContextState;
}) {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const unavailable = tenantState.status !== "ready";

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (unavailable) return;
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
    <form className="dm-login-card" onSubmit={handleSubmit} aria-busy={tenantState.status === "loading"}>
      <div className="dm-login-card-heading">
        <span className="dm-login-eyebrow">{profile.spaceLabel}</span>
        <h1>{profile.welcome}</h1>
        <p>{profile.welcomeDescription}</p>
      </div>

      {profile.isTenant ? (
        <div className="dm-login-tenant-hint">
          <Building2 size={15} aria-hidden="true" />
          <span>正在访问</span>
          <strong>{profile.tenantName}</strong>
        </div>
      ) : null}

      {tenantState.status === "loading" ? (
        <div className="dm-login-context-status" role="status">正在识别企业知识空间…</div>
      ) : null}

      {tenantState.status === "error" ? (
        <div className="dm-login-context-error" role="alert">
          <strong>无法进入此企业空间</strong>
          <span>{tenantState.message}</span>
          <Link href="/login">返回通用登录</Link>
        </div>
      ) : null}

      <label className="dm-field">
        <span>用户 ID</span>
        <span className="dm-login-input-wrap">
          <UserRound size={16} aria-hidden="true" />
          <input
            autoComplete="username"
            type="text"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="请输入用户 ID"
            required
            disabled={unavailable}
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
            placeholder="请输入密码"
            required
            disabled={unavailable}
          />
        </span>
      </label>

      {error ? <div className="dm-login-error" role="alert">{error}</div> : null}

      <button className="dm-button primary dm-login-submit" type="submit" disabled={busy || unavailable}>
        {busy ? "登录中…" : profile.isTenant ? `进入 ${profile.tenantName}` : "登录"}
      </button>

      <p className="dm-login-footnote">安全访问企业文档、可信引用与知识工作流</p>
    </form>
  );
}

function TenantLoginExperience() {
  const searchParams = useSearchParams();
  const tenantSlug = searchParams.get("tenant")?.trim() || undefined;
  const [tenantState, setTenantState] = useState<TenantContextState>(() =>
    tenantSlug ? { status: "loading", context: null } : { status: "ready", context: null }
  );

  useEffect(() => {
    let active = true;
    if (!tenantSlug) {
      setTenantState({ status: "ready", context: null });
      return () => {
        active = false;
      };
    }
    setTenantState({ status: "loading", context: null });
    getTenantLoginContext(tenantSlug)
      .then((context) => {
        if (active) setTenantState({ status: "ready", context });
      })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : "暂时无法识别企业登录入口";
        if (active) setTenantState({ status: "error", context: null, message });
      });
    return () => {
      active = false;
    };
  }, [tenantSlug]);

  const profile = useMemo(
    () => createTenantLoginProfile(tenantState.status === "ready" ? tenantState.context : null),
    [tenantState]
  );

  return (
    <main
      className={`dm-login-page ${tenantState.status === "loading" ? "is-resolving" : ""}`}
      data-tenant-tone={profile.tone}
    >
      <header className="dm-login-brandbar">
        <div className="dm-login-brand-identity">
          <BrandMark />
          {profile.isTenant ? (
            <>
              <span className="dm-login-brand-divider" aria-hidden="true" />
              <strong title={profile.tenantName}>{profile.tenantName}</strong>
            </>
          ) : null}
        </div>
      </header>

      <section className="dm-login-story" aria-label={`${profile.tenantName} 知识空间介绍`}>
        <div className="dm-login-story-watermark" aria-hidden="true">{profile.monogram}</div>
        <div className="dm-login-story-copy">
          <div className="dm-login-story-kicker">
            <span aria-hidden="true" />
            {profile.kicker}
          </div>
          <h2>
            <span>{profile.headlineLead}</span>
            <strong>{profile.headline}</strong>
          </h2>
          <p>{profile.description}</p>
          <ul className="dm-login-story-principles" aria-label="知识空间特性">
            {profile.principles.map((principle, index) => (
              <li key={principle}><span>0{index + 1}</span>{principle}</li>
            ))}
          </ul>
          <div className="dm-login-story-signature">{profile.signature}</div>
        </div>
        <AgentOrb size="large" />
      </section>

      <LoginForm profile={profile} tenantSlug={profile.tenantSlug ?? tenantSlug} tenantState={tenantState} />
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="dm-login-page"><div className="dm-login-card dm-login-card-loading">正在准备登录空间…</div></main>}>
      <TenantLoginExperience />
    </Suspense>
  );
}
