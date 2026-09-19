"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/providers/auth-provider";
import {
  AUTHENTICATED_HOME_PATH,
  listAccountTenants,
  switchAccountTenant,
  updateAccountProfile,
  type AccountTenant,
} from "@/lib/auth";
import styles from "./account.module.css";
import { BrandMark } from "@/components/ui/brand-mark";

export default function AccountPage() {
  const router = useRouter();
  const { me, loading, refresh } = useAuth();
  const [name, setName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [tenants, setTenants] = useState<AccountTenant[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (loading) return;
    if (!me) {
      router.replace("/login");
      return;
    }
    if (!me.tenant) {
      router.replace("/onboarding/tenant");
      return;
    }
    setName(me.user.name || "");
    setAvatarUrl(me.user.avatar_url || "");
    listAccountTenants().then(setTenants).catch(() => setTenants([]));
  }, [loading, me, router]);

  useEffect(() => setAvatarFailed(false), [avatarUrl]);

  if (loading || !me) return <main className={styles.page}>加载中…</main>;

  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      await updateAccountProfile(name, avatarUrl);
      await refresh();
      setMessage("个人资料已更新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const switchTenant = async (tenant: AccountTenant) => {
    if (tenant.current) return;
    setBusy(true);
    setMessage("");
    try {
      await switchAccountTenant(tenant.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "切换失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={styles.page}>
      <div className="dm-account-brandbar">
        <BrandMark />
      </div>
      <div className={styles.container}>
        <Link className={styles.back} href={AUTHENTICATED_HOME_PATH}>
          <ArrowLeft size={15} /> 返回
        </Link>
        <header className={styles.header}>
          <h1>账号与个人资料</h1>
          <p>管理公开显示信息，以及当前工作的租户空间。</p>
        </header>
        <div className={styles.grid}>
          <section className={styles.card}>
            <h2>个人资料</h2>
            <p>用户 ID 用于登录，展示名称用于页面显示。</p>
            <div className={styles.profilePreview}>
              <span className={styles.avatar}>
                {avatarUrl && !avatarFailed
                  ? <img alt="" onError={() => setAvatarFailed(true)} src={avatarUrl} />
                  : (name || me.user.login_id).trim().slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{name.trim() || me.user.login_id}</strong>
                <small>头像会显示在账号菜单和对话中</small>
              </span>
            </div>
            <label className={styles.field}>
              <span>展示名称</span>
              <input maxLength={128} onChange={(event) => setName(event.target.value)} value={name} />
            </label>
            <label className={styles.field}>
              <span>用户 ID</span>
              <input disabled value={me.user.login_id} />
            </label>
            {me.user.email ? (
              <label className={styles.field}>
                <span>联系邮箱</span>
                <input disabled value={me.user.email} />
              </label>
            ) : null}
            <label className={styles.field}>
              <span>头像地址（可选）</span>
              <input maxLength={2048} onChange={(event) => setAvatarUrl(event.target.value)} placeholder="https://…" type="url" value={avatarUrl} />
            </label>
            <div className={styles.actions}>
              <button className={styles.primary} disabled={busy || !name.trim()} onClick={save} type="button">
                保存资料
              </button>
              {message ? <span className={styles.message}>{message}</span> : null}
            </div>
          </section>

          <section className={styles.card}>
            <h2>租户空间</h2>
            <p>{me.scope === "platform" ? "当前为平台管理会话。" : "仅展示已启用且你仍为成员的租户。"}</p>
            <div className={styles.tenantList}>
              {tenants.map((tenant) => (
                <div className={styles.tenant} key={tenant.id}>
                  <span>
                    <strong>{tenant.name}</strong>
                    <small>{tenant.slug} · {tenant.roles.includes("tenant_admin") ? "租户管理员" : "普通用户"}</small>
                  </span>
                  {tenant.current ? (
                    <span className={styles.current}>当前空间</span>
                  ) : (
                    <button disabled={busy} onClick={() => switchTenant(tenant)} type="button">切换</button>
                  )}
                </div>
              ))}
              {tenants.length === 0 ? <div className={styles.empty}>没有可切换的租户空间</div> : null}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
