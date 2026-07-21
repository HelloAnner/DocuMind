"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, MailPlus, RotateCw, Search, Trash2, UserRound, X } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import {
  createTenantInvitation,
  listAdminMembers,
  listTenantInvitations,
  removeAdminMember,
  resendTenantInvitation,
  revokeTenantInvitation,
  updateAdminMember,
  type AdminMember,
  type TenantInvitation,
} from "@/lib/api";
import styles from "./admin-members.module.css";

const roleLabel = (role: string) => role === "tenant_admin" ? "租户管理员" : "普通用户";
const invitationStatusLabel: Record<string, string> = {
  pending: "待接受",
  accepted: "已接受",
  revoked: "已撤销",
  expired: "已过期",
};

export function AdminMembers() {
  const { me } = useAuth();
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [invitations, setInvitations] = useState<TenantInvitation[]>([]);
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<"end_user" | "tenant_admin">("end_user");
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [latestInviteUrl, setLatestInviteUrl] = useState("");

  const reload = async () => {
    const [nextMembers, nextInvitations] = await Promise.all([
      listAdminMembers(),
      listTenantInvitations(),
    ]);
    setMembers(nextMembers);
    setInvitations(nextInvitations);
  };

  useEffect(() => {
    reload().catch((error) => setMessage(error instanceof Error ? error.message : "加载失败"));
  }, []);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return members;
    return members.filter((member) => [member.email, member.name, ...member.roles]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(keyword));
  }, [members, query]);

  const absoluteInviteUrl = (url?: string) => {
    if (!url || typeof window === "undefined") return url || "";
    const prefix = window.location.pathname.startsWith("/documind") ? "/documind" : "";
    return `${window.location.origin}${prefix}${url}`;
  };

  const createInvite = async () => {
    setBusy("create");
    setMessage("");
    try {
      const invitation = await createTenantInvitation({
        email: inviteEmail,
        name: inviteName || undefined,
        roles: [inviteRole],
        expires_in_days: expiresInDays,
      });
      const url = absoluteInviteUrl(invitation.invite_url);
      setLatestInviteUrl(url);
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      await reload();
      setInviteEmail("");
      setInviteName("");
      setMessage("邀请已创建，链接已复制。链接只会在创建或重发时展示。 ");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "邀请失败");
    } finally {
      setBusy(null);
    }
  };

  const updateRole = async (member: AdminMember, role: "tenant_admin" | "end_user") => {
    if (member.roles.includes(role)) return;
    if (!confirm(`确定将 ${member.name || member.email} 调整为${roleLabel(role)}吗？`)) return;
    setBusy(member.id);
    setMessage("");
    try {
      await updateAdminMember(member.id, { role });
      await reload();
      setMessage("成员角色已更新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "角色更新失败");
    } finally {
      setBusy(null);
    }
  };

  const toggleStatus = async (member: AdminMember) => {
    const next = member.status === "active" ? "suspended" : "active";
    if (!confirm(`确定${next === "active" ? "启用" : "停用"} ${member.name || member.email} 吗？`)) return;
    setBusy(member.id);
    setMessage("");
    try {
      await updateAdminMember(member.id, { status: next });
      await reload();
      setMessage("成员状态已更新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "状态更新失败");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (member: AdminMember) => {
    if (!confirm(`确定从当前租户移除 ${member.name || member.email} 吗？其账号本身及其他租户身份不会删除。`)) return;
    setBusy(member.id);
    setMessage("");
    try {
      await removeAdminMember(member.id);
      await reload();
      setMessage("成员已从当前租户移除");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "移除失败");
    } finally {
      setBusy(null);
    }
  };

  const resend = async (invitation: TenantInvitation) => {
    setBusy(invitation.id);
    setMessage("");
    try {
      const next = await resendTenantInvitation(invitation.id);
      const url = absoluteInviteUrl(next.invite_url);
      setLatestInviteUrl(url);
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      await reload();
      setMessage("邀请链接已刷新并复制，有效期重新计算为 7 天");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重发失败");
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (invitation: TenantInvitation) => {
    if (!confirm(`确定撤销发给 ${invitation.email} 的邀请吗？`)) return;
    setBusy(invitation.id);
    setMessage("");
    try {
      await revokeTenantInvitation(invitation.id);
      await reload();
      setMessage("邀请已撤销");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "撤销失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div><span>租户管理</span><h1>成员与邀请</h1><p>角色只保留租户管理员和普通用户；所有操作仅作用于当前租户。</p></div>
        <button className={styles.primary} onClick={() => { setDrawerOpen(true); setLatestInviteUrl(""); }} type="button"><MailPlus size={16} /> 邀请成员</button>
      </header>

      <section className={styles.summary}>
        <div><strong>{members.filter((item) => item.status === "active").length}</strong><span>启用成员</span></div>
        <div><strong>{members.filter((item) => item.status === "active" && item.roles.includes("tenant_admin")).length}</strong><span>租户管理员</span></div>
        <div><strong>{invitations.filter((item) => item.status === "pending").length}</strong><span>待接受邀请</span></div>
      </section>

      {message ? <div className={styles.notice}>{message}</div> : null}

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div><h2>租户成员</h2><p>超级管理员不会出现在租户成员列表中。</p></div>
          <label className={styles.search}><Search size={15} /><input onChange={(event) => setQuery(event.target.value)} placeholder="搜索成员" value={query} /></label>
        </div>
        <div className={styles.table}>
          <div className={`${styles.memberRow} ${styles.tableHead}`}><span>成员</span><span>角色</span><span>知识库范围</span><span>最近活动</span><span>状态</span><span>操作</span></div>
          {filtered.map((member) => {
            const currentUser = me?.user.id === member.id;
            const role = member.roles.includes("tenant_admin") ? "tenant_admin" : "end_user";
            return (
              <div className={styles.memberRow} key={member.id}>
                <div className={styles.person}><span><UserRound size={15} /></span><div><strong>{member.name || member.email}{currentUser ? "（你）" : ""}</strong><small>{member.email}</small></div></div>
                <select disabled={busy === member.id || currentUser} onChange={(event) => updateRole(member, event.target.value as "tenant_admin" | "end_user")} value={role}><option value="tenant_admin">租户管理员</option><option value="end_user">普通用户</option></select>
                <span className={styles.scope}>{role === "tenant_admin" ? "全部知识库" : member.allowed_kb_names.join("、") || "未授权"}</span>
                <span>{member.last_seen_at ? new Date(member.last_seen_at).toLocaleString() : "尚无活动"}</span>
                <span className={`${styles.state} ${member.status === "active" ? styles.enabled : styles.disabled}`}>{member.status === "active" ? "启用中" : "已停用"}</span>
                <div className={styles.rowActions}>
                  <button disabled={busy === member.id || currentUser} onClick={() => toggleStatus(member)} type="button">{member.status === "active" ? "停用" : "启用"}</button>
                  <button className={styles.danger} disabled={busy === member.id || currentUser} onClick={() => remove(member)} type="button">移除</button>
                </div>
              </div>
            );
          })}
          {filtered.length === 0 ? <div className={styles.empty}>没有匹配的成员</div> : null}
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}><div><h2>邀请记录</h2><p>出于安全考虑，旧邀请链接不会再次显示；需要时请重发生成新链接。</p></div></div>
        <div className={styles.table}>
          <div className={`${styles.inviteRow} ${styles.tableHead}`}><span>受邀人</span><span>角色</span><span>创建时间</span><span>到期时间</span><span>状态</span><span>操作</span></div>
          {invitations.map((invitation) => (
            <div className={styles.inviteRow} key={invitation.id}>
              <span><strong>{invitation.name || invitation.email}</strong><small>{invitation.email}</small></span>
              <span>{invitation.roles.map(roleLabel).join("、")}</span>
              <span>{new Date(invitation.created_at).toLocaleDateString()}</span>
              <span>{new Date(invitation.expires_at).toLocaleString()}</span>
              <span className={`${styles.state} ${styles[invitation.status]}`}>{invitationStatusLabel[invitation.status] || invitation.status}</span>
              <div className={styles.rowActions}>
                <button disabled={busy === invitation.id || invitation.status !== "pending"} onClick={() => resend(invitation)} type="button"><RotateCw size={13} /> 重发</button>
                <button className={styles.danger} disabled={busy === invitation.id || invitation.status !== "pending"} onClick={() => revoke(invitation)} type="button"><Trash2 size={13} /> 撤销</button>
              </div>
            </div>
          ))}
          {invitations.length === 0 ? <div className={styles.empty}>暂无邀请记录</div> : null}
        </div>
      </section>

      {drawerOpen ? (
        <div className={styles.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) setDrawerOpen(false); }}>
          <aside className={styles.drawer}>
            <div className={styles.drawerHeader}><div><span>INVITE MEMBER</span><h2>邀请租户成员</h2></div><button aria-label="关闭" onClick={() => setDrawerOpen(false)} type="button"><X size={18} /></button></div>
            <p className={styles.drawerIntro}>租户管理员可管理成员与全部知识库；普通用户只能访问明确授权的知识库并进行问答。</p>
            <label className={styles.field}><span>邮箱 *</span><input autoFocus onChange={(event) => setInviteEmail(event.target.value)} placeholder="name@company.com" type="email" value={inviteEmail} /></label>
            <label className={styles.field}><span>姓名</span><input onChange={(event) => setInviteName(event.target.value)} placeholder="可选" value={inviteName} /></label>
            <label className={styles.field}><span>租户角色</span><select onChange={(event) => setInviteRole(event.target.value as "tenant_admin" | "end_user")} value={inviteRole}><option value="end_user">普通用户</option><option value="tenant_admin">租户管理员</option></select></label>
            <label className={styles.field}><span>邀请有效期</span><select onChange={(event) => setExpiresInDays(Number(event.target.value))} value={expiresInDays}><option value={1}>1 天</option><option value={3}>3 天</option><option value={7}>7 天</option><option value={14}>14 天</option><option value={30}>30 天</option></select></label>
            {latestInviteUrl ? <div className={styles.inviteResult}><span>新邀请链接</span><code>{latestInviteUrl}</code><button onClick={() => navigator.clipboard?.writeText(latestInviteUrl)} type="button"><Copy size={14} /> 复制链接</button></div> : null}
            <div className={styles.drawerActions}><button onClick={() => setDrawerOpen(false)} type="button">取消</button><button className={styles.primary} disabled={busy === "create" || !inviteEmail.trim()} onClick={createInvite} type="button">{busy === "create" ? "生成中…" : "生成邀请链接"}</button></div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
