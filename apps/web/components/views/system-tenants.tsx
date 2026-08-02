"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, Check, Copy, ExternalLink, Link2, MoreHorizontal, Plus, X } from "lucide-react";
import {
  createSystemTenant,
  generateSystemTenantAdminInvitation,
  listSystemTenants,
  requestSystemTenantDeletion,
  updateSystemTenant,
  type SystemTenant,
} from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { Segmented } from "@/components/ui/segmented";
import { StatCard } from "@/components/ui/stat-card";
import { Topbar } from "@/components/ui/topbar";
import styles from "./system-tenants.module.css";

const statusLabel: Record<SystemTenant["status"], string> = {
  pending: "待管理员加入",
  active: "运行中",
  suspended: "已停用",
  archived: "已归档",
  deletion_pending: "待删除",
};

const statusTone = (status: SystemTenant["status"]) => {
  switch (status) {
    case "active":
      return "success";
    case "pending":
    case "suspended":
      return "warning";
    case "deletion_pending":
      return "danger";
    default:
      return "neutral";
  }
};

const planLabel: Record<SystemTenant["plan"], string> = {
  trial: "试用版",
  team: "团队版",
  enterprise: "企业版",
};

const statusOptions: { value: SystemTenant["status"] | "all"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "active", label: "运行中" },
  { value: "pending", label: "待加入" },
  { value: "suspended", label: "已停用" },
  { value: "archived", label: "已归档" },
  { value: "deletion_pending", label: "待删除" },
];

const initialForm = {
  name: "",
  slug: "",
  plan: "enterprise" as SystemTenant["plan"],
  admin_email: "",
  admin_name: "",
  expires_in_days: 7,
};

function basePath() {
  if (typeof window === "undefined") return "";
  return window.location.pathname.startsWith("/documind") ? "/documind" : "";
}

function absoluteUrl(path: string) {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${basePath()}${path}`;
}

function tenantAccessUrl(slug: string) {
  return absoluteUrl(`/login?tenant=${encodeURIComponent(slug)}`);
}

export function SystemTenants() {
  const [tenants, setTenants] = useState<SystemTenant[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SystemTenant["status"] | "all">("all");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  const reload = async () => setTenants(await listSystemTenants());

  useEffect(() => {
    reload().catch((error) => setMessage(error instanceof Error ? error.message : "加载失败"));
  }, []);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return tenants.filter((tenant) => {
      const matchesStatus = status === "all" || tenant.status === status;
      const matchesQuery =
        !keyword ||
        [tenant.name, tenant.slug, tenant.plan].join(" ").toLowerCase().includes(keyword);
      return matchesStatus && matchesQuery;
    });
  }, [query, status, tenants]);

  const metrics = {
    total: tenants.length,
    active: tenants.filter((t) => t.status === "active").length,
    members: tenants.reduce((sum, t) => sum + t.member_count, 0),
    pendingInvitations: tenants.reduce((sum, t) => sum + t.pending_invitation_count, 0),
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
      const url = absoluteUrl(result.invitation.invite_url);
      setInviteUrl(url);
      const copied = await copyToClipboard(url);
      await reload();
      setMessage(copied
        ? "租户已创建，初始管理员邀请链接已复制。接受邀请后租户会自动启用。"
        : "租户已创建。请在下方复制初始管理员邀请链接；接受邀请后租户会自动启用。");
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

  const copyAdminInvitation = async (tenant: SystemTenant) => {
    const email = tenant.status === "active"
      ? prompt("请输入要邀请为租户管理员的邮箱：")?.trim()
      : undefined;
    if (tenant.status === "active" && !email) return;
    const raw = prompt("将生成新的管理员邀请链接；同一邮箱的旧链接立即失效。请输入有效天数（1-30）：", "7");
    if (raw === null) return;
    const days = Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 30) {
      setMessage("有效天数必须是 1 到 30 之间的整数");
      return;
    }
    setBusy(tenant.id);
    setMessage("");
    try {
      const invitation = await generateSystemTenantAdminInvitation(tenant.id, days, email);
      const url = absoluteUrl(invitation.invite_url);
      const copied = await copyToClipboard(url);
      if (!copied) prompt("自动复制失败，请手动复制管理员邀请链接：", url);
      await reload();
      setMessage(copied
        ? `已复制 ${invitation.email} 的管理员邀请链接，有效期 ${days} 天`
        : `已生成 ${invitation.email} 的管理员邀请链接`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "管理员邀请生成失败");
    } finally {
      setBusy(null);
    }
  };

  const copyAccessUrl = async (slug: string) => {
    const ok = await copyToClipboard(tenantAccessUrl(slug));
    if (ok) {
      setCopiedSlug(slug);
      setTimeout(() => setCopiedSlug((current) => (current === slug ? null : current)), 1500);
    }
  };

  return (
    <>
      <Topbar title="租户管理" subtitle="复制成员登录链接；平台管理员只有被明确加入该租户后，才会以租户成员身份进入">
        <Button icon={<Plus size={14} />} onClick={() => { setDrawerOpen(true); setInviteUrl(""); }}>
          新建租户
        </Button>
      </Topbar>

      <div className="dm-admin-content">
        <div className="dm-stat-row">
          <StatCard label="全部租户" value={String(metrics.total)} hint="平台实例" />
          <StatCard label="运行中" value={String(metrics.active)} hint="可登录" />
          <StatCard label="有效成员" value={metrics.members.toLocaleString()} hint="跨租户汇总" />
          <StatCard label="待接受邀请" value={String(metrics.pendingInvitations)} hint="初始管理员" />
        </div>

        {message ? <div className="dm-inline-error" style={{ marginTop: 16 }}>{message}</div> : null}

        <div className="dm-filter-bar" style={{ marginTop: 24 }}>
          <SearchInput
            placeholder="搜索名称或租户标识"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div style={{ flex: 1 }} />
          <Segmented
            options={statusOptions}
            value={status}
            onChange={(value) => setStatus(value)}
          />
        </div>

        <Panel title="租户列表" action={<span style={{ color: "var(--text-muted)", fontSize: 12 }}>共 {filtered.length} 个</span>}>
          <div className="dm-table-head dm-tenant-row">
            <span>租户</span>
            <span>状态</span>
            <span>成员 / 管理员</span>
            <span>内容规模</span>
            <span>套餐</span>
            <span>成员登录链接</span>
            <span>操作</span>
          </div>
          {filtered.map((tenant) => (
            <div className="dm-table-row dm-tenant-row" key={tenant.id}>
              <div className="dm-user-cell">
                <span className="dm-avatar">
                  <Building2 size={14} />
                </span>
                <span>
                  <strong>{tenant.name}</strong>
                  <small>{tenant.slug} · 更新于 {new Date(tenant.updated_at).toLocaleDateString()}</small>
                </span>
              </div>
              <Badge tone={statusTone(tenant.status)}>{statusLabel[tenant.status]}</Badge>
              <span>
                {tenant.member_count} 位成员
                <small>{tenant.active_admin_count} 位管理员 · {tenant.pending_invitation_count} 个邀请</small>
              </span>
              <span>
                {tenant.doc_count.toLocaleString()} 文档
                <small>{tenant.kb_count} 个知识库</small>
              </span>
              <span>{planLabel[tenant.plan]}</span>
              <div className="dm-row-actions" style={{ justifyContent: "flex-start" }}>
                <button
                  aria-label="复制成员登录链接"
                  onClick={() => copyAccessUrl(tenant.slug)}
                  title={tenantAccessUrl(tenant.slug)}
                  type="button"
                >
                  {copiedSlug === tenant.slug ? <Check size={14} /> : <Link2 size={14} />}
                  {copiedSlug === tenant.slug ? "已复制" : "复制链接"}
                </button>
                <a href={tenantAccessUrl(tenant.slug)} rel="noreferrer" target="_blank">
                  <ExternalLink size={14} /> 打开登录
                </a>
              </div>
              <div className="dm-row-actions">
                {tenant.status === "pending" || tenant.status === "active" ? (
                  <button disabled={busy === tenant.id} onClick={() => copyAdminInvitation(tenant)} type="button">
                    <Copy size={14} /> 复制管理员邀请
                  </button>
                ) : null}
                {tenant.status === "active" ? (
                  <button disabled={busy === tenant.id} onClick={() => changeStatus(tenant, "suspended")} type="button">
                    停用
                  </button>
                ) : null}
                {tenant.status === "suspended" || tenant.status === "archived" ? (
                  <button disabled={busy === tenant.id} onClick={() => changeStatus(tenant, "active")} type="button">
                    启用
                  </button>
                ) : null}
                {tenant.status !== "archived" && tenant.status !== "deletion_pending" ? (
                  <button disabled={busy === tenant.id} onClick={() => changeStatus(tenant, "archived")} type="button">
                    归档
                  </button>
                ) : null}
                {tenant.status !== "deletion_pending" ? (
                  <button className="danger" disabled={busy === tenant.id} onClick={() => deleteTenant(tenant)} type="button">
                    删除
                  </button>
                ) : (
                  <MoreHorizontal size={16} />
                )}
              </div>
            </div>
          ))}
          {filtered.length === 0 ? <div className="dm-empty-state">没有匹配的租户</div> : null}
        </Panel>
      </div>

      {drawerOpen ? (
        <div className={styles.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) setDrawerOpen(false); }}>
          <aside className={styles.drawer}>
            <div className={styles.drawerHeader}>
              <div>
                <span>新建租户</span>
                <h2>创建租户并邀请管理员</h2>
              </div>
              <button aria-label="关闭" onClick={() => setDrawerOpen(false)} type="button"><X size={18} /></button>
            </div>
            <p className={styles.drawerIntro}>租户先以“待管理员加入”状态创建。初始管理员接受邀请后，租户才正式启用。</p>
            <label className={styles.field}>
              <span>租户名称 *</span>
              <input autoFocus onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：Northwind Research" value={form.name} />
            </label>
            <label className={styles.field}>
              <span>租户标识 Slug</span>
              <input onChange={(event) => setForm({ ...form, slug: event.target.value })} placeholder="留空时由名称生成" value={form.slug} />
            </label>
            <label className={styles.field}>
              <span>套餐</span>
              <select onChange={(event) => setForm({ ...form, plan: event.target.value as SystemTenant["plan"] })} value={form.plan}>
                <option value="trial">试用版</option>
                <option value="team">团队版</option>
                <option value="enterprise">企业版</option>
              </select>
            </label>
            <div className={styles.separator}><span>初始租户管理员</span></div>
            <label className={styles.field}>
              <span>管理员邮箱 *</span>
              <input onChange={(event) => setForm({ ...form, admin_email: event.target.value })} placeholder="admin@company.com" type="email" value={form.admin_email} />
            </label>
            <label className={styles.field}>
              <span>管理员姓名</span>
              <input onChange={(event) => setForm({ ...form, admin_name: event.target.value })} placeholder="可选" value={form.admin_name} />
            </label>
            <label className={styles.field}>
              <span>邀请有效期</span>
              <select onChange={(event) => setForm({ ...form, expires_in_days: Number(event.target.value) })} value={form.expires_in_days}>
                <option value={1}>1 天</option>
                <option value={3}>3 天</option>
                <option value={7}>7 天</option>
                <option value={14}>14 天</option>
                <option value={30}>30 天</option>
              </select>
            </label>
            {inviteUrl ? (
              <div className={styles.inviteResult}>
                <span>一次性邀请链接</span>
                <code>{inviteUrl}</code>
                <button onClick={() => copyToClipboard(inviteUrl)} type="button">
                  <Copy size={14} /> 再次复制
                </button>
              </div>
            ) : null}
            <div className={styles.drawerActions}>
              <button onClick={() => setDrawerOpen(false)} type="button">取消</button>
              <button
                className={styles.primary}
                disabled={busy === "create" || !form.name.trim() || !form.admin_email.trim()}
                onClick={createTenant}
                type="button"
              >
                {busy === "create" ? "创建中…" : "创建并生成邀请"}
              </button>
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
