"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, MailPlus, RotateCw, Trash2, UserRound, X } from "lucide-react";
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
import { copyToClipboard } from "@/lib/clipboard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { StatCard } from "@/components/ui/stat-card";
import { Topbar } from "@/components/ui/topbar";
import styles from "./admin-members.module.css";

const roleLabel = (role: string) => (role === "tenant_admin" ? "租户管理员" : "普通用户");

const invitationStatusLabel: Record<string, string> = {
  pending: "待接受",
  accepted: "已接受",
  revoked: "已撤销",
  expired: "已过期",
};

const invitationTone = (status: string) => {
  switch (status) {
    case "accepted":
      return "success";
    case "pending":
      return "warning";
    case "expired":
    case "revoked":
      return "neutral";
    default:
      return "neutral";
  }
};

function basePath() {
  if (typeof window === "undefined") return "";
  return window.location.pathname.startsWith("/documind") ? "/documind" : "";
}

function absoluteUrl(path: string) {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${basePath()}${path}`;
}

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
  const [copiedId, setCopiedId] = useState<string | null>(null);

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
    return members.filter((member) =>
      [member.email, member.name, ...member.roles]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(keyword)
    );
  }, [members, query]);

  const activeMembers = members.filter((m) => m.status === "active");
  const adminCount = activeMembers.filter((m) => m.roles.includes("tenant_admin")).length;
  const pendingInvitations = invitations.filter((i) => i.status === "pending").length;

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
      const url = absoluteUrl(invitation.invite_url ?? "");
      setLatestInviteUrl(url);
      await copyToClipboard(url);
      await reload();
      setInviteEmail("");
      setInviteName("");
      setMessage("邀请已创建，链接已复制。链接只会在创建或重发时展示。");
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
      const url = absoluteUrl(next.invite_url ?? "");
      setLatestInviteUrl(url);
      await copyToClipboard(url);
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

  const copyInvite = async (invitation: TenantInvitation) => {
    if (!invitation.invite_url) return;
    const ok = await copyToClipboard(absoluteUrl(invitation.invite_url));
    if (ok) {
      setCopiedId(invitation.id);
      setTimeout(() => setCopiedId((current) => (current === invitation.id ? null : current)), 1500);
    }
  };

  return (
    <>
      <Topbar title="成员与邀请" subtitle="角色仅保留租户管理员和普通用户；所有操作仅作用于当前租户">
        <Button icon={<MailPlus size={14} />} onClick={() => { setDrawerOpen(true); setLatestInviteUrl(""); }}>
          邀请成员
        </Button>
      </Topbar>

      <div className="dm-admin-content">
        <div className="dm-stat-row">
          <StatCard label="启用成员" value={String(activeMembers.length)} hint="当前租户" />
          <StatCard label="租户管理员" value={String(adminCount)} hint="已启用" />
          <StatCard label="待接受邀请" value={String(pendingInvitations)} hint="有效邀请" />
          <StatCard label="知识库授权" value={String(members.reduce((sum, m) => sum + m.allowed_kb_names.length, 0))} hint="成员级" />
        </div>

        {message ? <div className="dm-inline-error" style={{ marginTop: 16 }}>{message}</div> : null}

        <div className="dm-filter-bar" style={{ marginTop: 24 }}>
          <SearchInput placeholder="搜索成员" value={query} onChange={(event) => setQuery(event.target.value)} />
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>共 {filtered.length} 位成员</span>
        </div>

        <Panel title="租户成员">
          <div className="dm-table-head dm-member-row">
            <span>成员</span>
            <span>角色</span>
            <span>知识库范围</span>
            <span>最近活动</span>
            <span>状态</span>
            <span>操作</span>
          </div>
          {filtered.map((member) => {
            const currentUser = me?.user.id === member.id;
            const role = member.roles.includes("tenant_admin") ? "tenant_admin" : "end_user";
            return (
              <div className="dm-table-row dm-member-row" key={member.id}>
                <div className="dm-user-cell">
                  <span className="dm-avatar">
                    <UserRound size={14} />
                  </span>
                  <span>
                    <strong>{member.name || member.email}{currentUser ? "（你）" : ""}</strong>
                    <small>{member.email}</small>
                  </span>
                </div>
                <select
                  className="dm-select"
                  disabled={busy === member.id || currentUser}
                  onChange={(event) => updateRole(member, event.target.value as "tenant_admin" | "end_user")}
                  value={role}
                >
                  <option value="tenant_admin">租户管理员</option>
                  <option value="end_user">普通用户</option>
                </select>
                <span title={role === "tenant_admin" ? "全部知识库" : member.allowed_kb_names.join("、")}>
                  {role === "tenant_admin" ? "全部知识库" : member.allowed_kb_names.join("、") || "未授权"}
                </span>
                <span>{member.last_seen_at ? new Date(member.last_seen_at).toLocaleString() : "尚无活动"}</span>
                <Badge tone={member.status === "active" ? "success" : "neutral"}>
                  {member.status === "active" ? "启用中" : "已停用"}
                </Badge>
                <div className="dm-row-actions">
                  <button disabled={busy === member.id || currentUser} onClick={() => toggleStatus(member)} type="button">
                    {member.status === "active" ? "停用" : "启用"}
                  </button>
                  <button className="danger" disabled={busy === member.id || currentUser} onClick={() => remove(member)} type="button">
                    移除
                  </button>
                </div>
              </div>
            );
          })}
          {filtered.length === 0 ? <div className="dm-empty-state">没有匹配的成员</div> : null}
        </Panel>

        <div style={{ marginTop: 16 }}>
          <Panel title="邀请记录">
            <div className="dm-table-head dm-invite-row">
            <span>受邀人</span>
            <span>角色</span>
            <span>创建时间</span>
            <span>到期时间</span>
            <span>状态</span>
            <span>操作</span>
          </div>
          {invitations.map((invitation) => (
            <div className="dm-table-row dm-invite-row" key={invitation.id}>
              <span>
                <strong>{invitation.name || invitation.email}</strong>
                <small>{invitation.email}</small>
              </span>
              <span>{invitation.roles.map(roleLabel).join("、")}</span>
              <span>{new Date(invitation.created_at).toLocaleDateString()}</span>
              <span>{new Date(invitation.expires_at).toLocaleString()}</span>
              <Badge tone={invitationTone(invitation.status)}>{invitationStatusLabel[invitation.status] || invitation.status}</Badge>
              <div className="dm-row-actions">
                {invitation.invite_url ? (
                  <IconButton
                    aria-label="复制邀请链接"
                    onClick={() => copyInvite(invitation)}
                    title="复制邀请链接"
                  >
                    {copiedId === invitation.id ? <Check size={14} /> : <Copy size={14} />}
                  </IconButton>
                ) : null}
                <button disabled={busy === invitation.id || invitation.status !== "pending"} onClick={() => resend(invitation)} type="button">
                  <RotateCw size={13} /> 重发
                </button>
                <button className="danger" disabled={busy === invitation.id || invitation.status !== "pending"} onClick={() => revoke(invitation)} type="button">
                  <Trash2 size={13} /> 撤销
                </button>
              </div>
            </div>
          ))}
          {invitations.length === 0 ? <div className="dm-empty-state">暂无邀请记录</div> : null}
          </Panel>
        </div>
      </div>

      {drawerOpen ? (
        <div className={styles.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) setDrawerOpen(false); }}>
          <aside className={styles.drawer}>
            <div className={styles.drawerHeader}>
              <div>
                <span>邀请成员</span>
                <h2>邀请租户成员</h2>
              </div>
              <button aria-label="关闭" onClick={() => setDrawerOpen(false)} type="button"><X size={18} /></button>
            </div>
            <p className={styles.drawerIntro}>租户管理员可管理成员与全部知识库；普通用户只能访问明确授权的知识库并进行问答。</p>
            <label className={styles.field}>
              <span>邮箱 *</span>
              <input autoFocus onChange={(event) => setInviteEmail(event.target.value)} placeholder="name@company.com" type="email" value={inviteEmail} />
            </label>
            <label className={styles.field}>
              <span>姓名</span>
              <input onChange={(event) => setInviteName(event.target.value)} placeholder="可选" value={inviteName} />
            </label>
            <label className={styles.field}>
              <span>租户角色</span>
              <select onChange={(event) => setInviteRole(event.target.value as "tenant_admin" | "end_user")} value={inviteRole}>
                <option value="end_user">普通用户</option>
                <option value="tenant_admin">租户管理员</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>邀请有效期</span>
              <select onChange={(event) => setExpiresInDays(Number(event.target.value))} value={expiresInDays}>
                <option value={1}>1 天</option>
                <option value={3}>3 天</option>
                <option value={7}>7 天</option>
                <option value={14}>14 天</option>
                <option value={30}>30 天</option>
              </select>
            </label>
            {latestInviteUrl ? (
              <div className={styles.inviteResult}>
                <span>新邀请链接</span>
                <code>{latestInviteUrl}</code>
                <button onClick={() => copyToClipboard(latestInviteUrl)} type="button">
                  <Copy size={14} /> 复制链接
                </button>
              </div>
            ) : null}
            <div className={styles.drawerActions}>
              <button onClick={() => setDrawerOpen(false)} type="button">取消</button>
              <button
                className={styles.primary}
                disabled={busy === "create" || !inviteEmail.trim()}
                onClick={createInvite}
                type="button"
              >
                {busy === "create" ? "生成中…" : "生成邀请链接"}
              </button>
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
