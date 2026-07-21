"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, Copy, MoreHorizontal, Plus, Search, X } from "lucide-react";
import {
  createSystemTenant,
  listSystemTenants,
  requestSystemTenantDeletion,
  resendSystemTenantInvitation,
  updateSystemTenant,
  type SystemTenant,
} from "@/lib/api";
import styles from "./system-tenants.module.css";

const statusLabel: Record<SystemTenant["status"], string> = {
  pending: "待管理员加入",
  active: "运行中",
  suspended: "已停用",
  archived: "已归档",
  deletion_pending: "待删除",
};

const planLabel: Record<SystemTenant["plan"], string> = {
  trial: "试用版",
  team: "团队版",
  enterprise: "企业版",
};

const initialForm = {
  name: "",
  slug: "",
  plan: "enterprise" as SystemTenant["plan"],
  admin_email: "",
  admin_name: "",
  expires_in_days: 7,
};

export function SystemTenants() {
  const [tenants, setTenants] = useState<SystemTenant[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");

  const reload = async () => setTenants(await listSystemTenants());

  useEffect(() => {
    reload().catch((error) => setMessage(error instanceof Error ? error.message : "加载失败"));
  }, []);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return tenants.filter((tenant) => {
      const matchesStatus = status === "all" || tenant.status === status;
      const matchesQuery = !keyword || [tenant.name, tenant.slug, tenant.plan]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
      return matchesStatus && matchesQuery;
    });
  }, [query, status, tenants]);

  const absoluteInviteUrl = (url: string) => {
    if (typeof window === "undefined") return url;
    const prefix = window.location.pathname.startsWith("/documind") ? "/documind" : "";
    return `${window.location.origin}${prefix}${url}`;
  };

  const createTenant = async () => {
    setBusy("create");
    setMessage("");
    try {
      const result = await createSystemTenant({
        ...form,
        slug: form.slug || undefined,
        admin_name: form.admin_name || undefined,
      });
      const url = absoluteInviteUrl(result.invitation.invite_url);
      setInviteUrl(url);
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      await reload();
      setMessage("租户已创建，初始管理员邀请链接已复制。接受邀请后租户会自动启用。");
      setForm(initialForm);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建失败");
    } finally {
      setBusy(null);
    }
  };

  const changeStatus = async (tenant: SystemTenant, next: SystemTenant["status"]) => {
    if (!confirm(`确定将「${tenant.name}」变更为“${statusLabel[next]}”吗？`)) return;
    setBusy(tenant.id);
    setMessage("");
    try {
      await updateSystemTenant(tenant.id, { status: next });
      await reload();
      setMessage(`已更新 ${tenant.name} 的运行状态`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "状态更新失败");
    } finally {
      setBusy(null);
    }
  };

  const deleteTenant = async (tenant: SystemTenant) => {
    const confirmation = prompt(`这是可恢复的删除申请。请输入租户标识 “${tenant.slug}” 继续：`);
    if (confirmation !== tenant.slug) {
      if (confirmation !== null) setMessage("租户标识不匹配，已取消操作");
      return;
    }
    setBusy(tenant.id);
    setMessage("");
    try {
      await requestSystemTenantDeletion(tenant.id, tenant.slug);
      await reload();
      setMessage(`${tenant.name} 已进入待删除状态，未接受的邀请已撤销`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除申请失败");
    } finally {
      setBusy(null);
    }
  };

  const resendInvitation = async (tenant: SystemTenant) => {
    const raw = prompt("请输入新邀请链接的有效天数（1-30）：", "7");
    if (raw === null) return;
    const days = Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 30) {
      setMessage("有效天数必须是 1 到 30 之间的整数");
      return;
    }
    setBusy(tenant.id);
    setMessage("");
    try {
      const invitation = await resendSystemTenantInvitation(tenant.id, days);
      const url = absoluteInviteUrl(invitation.invite_url);
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      await reload();
      setMessage(`已为 ${invitation.email} 生成新邀请链接并复制，有效期 ${days} 天`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "邀请重发失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>PLATFORM GOVERNANCE</span>
          <h1>租户管理</h1>
          <p>管理租户生命周期和初始管理员邀请；平台管理员不进入租户知识库。</p>
        </div>
        <button className={styles.primary} onClick={() => { setDrawerOpen(true); setInviteUrl(""); }} type="button">
          <Plus size={16} /> 新建租户
        </button>
      </header>

      <section className={styles.metrics}>
        <div><strong>{tenants.length}</strong><span>全部租户</span></div>
        <div><strong>{tenants.filter((item) => item.status === "active").length}</strong><span>运行中</span></div>
        <div><strong>{tenants.reduce((sum, item) => sum + item.member_count, 0)}</strong><span>有效成员</span></div>
        <div><strong>{tenants.reduce((sum, item) => sum + item.pending_invitation_count, 0)}</strong><span>待接受邀请</span></div>
      </section>

      <section className={styles.card}>
        <div className={styles.toolbar}>
          <label className={styles.search}>
            <Search size={15} />
            <input onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或租户标识" value={query} />
          </label>
          <div className={styles.filters}>
            {["all", "active", "pending", "suspended", "archived", "deletion_pending"].map((value) => (
              <button className={status === value ? styles.activeFilter : ""} key={value} onClick={() => setStatus(value)} type="button">
                {value === "all" ? "全部" : statusLabel[value as SystemTenant["status"]]}
              </button>
            ))}
          </div>
        </div>
        {message ? <div className={styles.notice}>{message}</div> : null}
        <div className={styles.table}>
          <div className={`${styles.row} ${styles.tableHead}`}>
            <span>租户</span><span>状态</span><span>成员 / 管理员</span><span>内容规模</span><span>套餐</span><span>操作</span>
          </div>
          {filtered.map((tenant) => (
            <div className={styles.row} key={tenant.id}>
              <div className={styles.tenantCell}>
                <span className={styles.tenantIcon}><Building2 size={16} /></span>
                <span><strong>{tenant.name}</strong><small>{tenant.slug} · 更新于 {new Date(tenant.updated_at).toLocaleDateString()}</small></span>
              </div>
              <span className={`${styles.status} ${styles[tenant.status]}`}>{statusLabel[tenant.status]}</span>
              <span><strong>{tenant.member_count}</strong><small>{tenant.active_admin_count} 位管理员 · {tenant.pending_invitation_count} 个邀请</small></span>
              <span><strong>{tenant.doc_count.toLocaleString()} 文档</strong><small>{tenant.kb_count} 个知识库</small></span>
              <span>{planLabel[tenant.plan]}</span>
              <div className={styles.actions}>
                {tenant.status === "pending" ? <button disabled={busy === tenant.id} onClick={() => resendInvitation(tenant)} type="button">重发邀请</button> : null}
                {tenant.status === "active" ? <button disabled={busy === tenant.id} onClick={() => changeStatus(tenant, "suspended")} type="button">停用</button> : null}
                {tenant.status === "suspended" || tenant.status === "archived" ? <button disabled={busy === tenant.id} onClick={() => changeStatus(tenant, "active")} type="button">启用</button> : null}
                {tenant.status !== "archived" && tenant.status !== "deletion_pending" ? <button disabled={busy === tenant.id} onClick={() => changeStatus(tenant, "archived")} type="button">归档</button> : null}
                {tenant.status !== "deletion_pending" ? <button className={styles.danger} disabled={busy === tenant.id} onClick={() => deleteTenant(tenant)} type="button">删除</button> : <MoreHorizontal size={16} />}
              </div>
            </div>
          ))}
          {filtered.length === 0 ? <div className={styles.empty}>没有匹配的租户</div> : null}
        </div>
      </section>

      {drawerOpen ? (
        <div className={styles.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) setDrawerOpen(false); }}>
          <aside className={styles.drawer}>
            <div className={styles.drawerHeader}>
              <div><span>NEW TENANT</span><h2>创建租户并邀请管理员</h2></div>
              <button aria-label="关闭" onClick={() => setDrawerOpen(false)} type="button"><X size={18} /></button>
            </div>
            <p className={styles.drawerIntro}>租户先以“待管理员加入”状态创建。初始管理员接受邀请后，租户才正式启用。</p>
            <label className={styles.field}><span>租户名称 *</span><input autoFocus onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：Northwind Research" value={form.name} /></label>
            <label className={styles.field}><span>租户标识 Slug</span><input onChange={(event) => setForm({ ...form, slug: event.target.value })} placeholder="留空时由名称生成" value={form.slug} /></label>
            <label className={styles.field}><span>套餐</span><select onChange={(event) => setForm({ ...form, plan: event.target.value as SystemTenant["plan"] })} value={form.plan}><option value="trial">试用版</option><option value="team">团队版</option><option value="enterprise">企业版</option></select></label>
            <div className={styles.separator}><span>初始租户管理员</span></div>
            <label className={styles.field}><span>管理员邮箱 *</span><input onChange={(event) => setForm({ ...form, admin_email: event.target.value })} placeholder="admin@company.com" type="email" value={form.admin_email} /></label>
            <label className={styles.field}><span>管理员姓名</span><input onChange={(event) => setForm({ ...form, admin_name: event.target.value })} placeholder="可选" value={form.admin_name} /></label>
            <label className={styles.field}><span>邀请有效期</span><select onChange={(event) => setForm({ ...form, expires_in_days: Number(event.target.value) })} value={form.expires_in_days}><option value={1}>1 天</option><option value={3}>3 天</option><option value={7}>7 天</option><option value={14}>14 天</option><option value={30}>30 天</option></select></label>
            {inviteUrl ? <div className={styles.inviteResult}><span>一次性邀请链接</span><code>{inviteUrl}</code><button onClick={() => navigator.clipboard?.writeText(inviteUrl)} type="button"><Copy size={14} /> 再次复制</button></div> : null}
            <div className={styles.drawerActions}>
              <button onClick={() => setDrawerOpen(false)} type="button">取消</button>
              <button className={styles.primary} disabled={busy === "create" || !form.name.trim() || !form.admin_email.trim()} onClick={createTenant} type="button">{busy === "create" ? "创建中…" : "创建并生成邀请"}</button>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
