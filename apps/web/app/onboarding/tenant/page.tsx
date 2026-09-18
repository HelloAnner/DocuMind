"use client";

import { Building2, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/providers/auth-provider";
import { createTenant, switchAccountTenant } from "@/lib/auth";
import { BrandMark } from "@/components/ui/brand-mark";

export default function TenantOnboardingPage() {
  const router = useRouter();
  const { me, loading, logout } = useAuth();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!loading && !me) router.replace("/login");
    if (!loading && me?.tenant) router.replace("/chat");
  }, [loading, me, router]);

  const enterTenant = async (tenantId: string) => {
    setBusy(true);
    setError("");
    try {
      await switchAccountTenant(tenantId);
      window.location.assign("/chat");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "进入租户失败");
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await createTenant(name);
      window.location.assign("/chat");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建租户失败");
      setBusy(false);
    }
  };

  if (loading || !me) return <main className="dm-login-page" />;

  return (
    <main className="dm-login-page">
      <header className="dm-login-brandbar"><BrandMark /></header>
      <section className="dm-login-story" aria-label="租户引导">
        <div className="dm-login-story-copy">
          <div className="dm-login-story-kicker"><span />账号已就绪</div>
          <h2><span>选择你的</span><strong>企业知识空间</strong></h2>
          <p>每个租户的数据完全隔离。你可以进入已有租户，或创建一个新的企业空间。</p>
        </div>
      </section>
      <section className="dm-login-card">
        <div className="dm-login-card-heading">
          <span className="dm-login-eyebrow">租户设置</span>
          <h1>选择或创建租户</h1>
          <p>当前账号：{me.user.login_id}</p>
        </div>
        {me.tenants.map((tenant) => (
          <button className="dm-button" disabled={busy} key={tenant.id} onClick={() => enterTenant(tenant.id)} type="button">
            <Building2 size={16} /> {tenant.name}
          </button>
        ))}
        <form onSubmit={submit}>
          <label className="dm-field"><span>新租户名称</span><span className="dm-login-input-wrap">
            <Plus size={16} /><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：星河科技" required />
          </span></label>
          {error ? <div className="dm-login-error" role="alert">{error}</div> : null}
          <button className="dm-button primary dm-login-submit" disabled={busy} type="submit">{busy ? "处理中…" : "创建并进入"}</button>
        </form>
        <button className="dm-button" onClick={logout} type="button">退出登录</button>
      </section>
    </main>
  );
}
