"use client";

import { useEffect, useState } from "react";
import { Copy, RotateCw, Send, Trash2, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { SearchInput } from "@/components/ui/search-input";
import { Topbar } from "@/components/ui/topbar";
import {
  createTenantInvitation,
  fetchJson,
  listTenantInvitations,
  resendTenantInvitation,
  revokeTenantInvitation,
  type TenantInvitation,
} from "@/lib/api";

interface Member {
  id: string;
  email: string;
  name?: string;
  roles: string[];
  allowed_kb_names: string[];
  query_count: number;
  status: string;
}

const roleLabel = (role: string) => {
  switch (role) {
    case "enterprise_admin":
    case "tenant_admin":
    case "tenant_owner":
      return "企业管理员";
    case "team_admin":
      return "团队管理员";
    case "data_admin":
      return "数据管理员";
    case "user":
    case "analyst":
    case "end_user":
      return "普通用户";
    case "viewer":
      return "只读用户";
    default:
      return role;
  }
};

export function AdminMembers() {
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<TenantInvitation[]>([]);
  const [query, setQuery] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState("end_user");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<Member[]>("/api/admin/members").then(setMembers).catch(console.error);
    listTenantInvitations().then(setInvitations).catch(console.error);
  }, []);

  const filtered = members.filter((m) =>
    m.email.toLowerCase().includes(query.toLowerCase()) ||
    (m.name ?? "").toLowerCase().includes(query.toLowerCase())
  );

  const reloadInvitations = async () => {
    setInvitations(await listTenantInvitations());
  };

  const absoluteInviteUrl = (url?: string) => {
    if (!url || typeof window === "undefined") return url || "";
    const prefix = window.location.pathname.startsWith("/documind") ? "/documind" : "";
    return `${window.location.origin}${prefix}${url}`;
  };

  const createInvite = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const invitation = await createTenantInvitation({
        email: inviteEmail,
        name: inviteName || undefined,
        roles: [inviteRole],
        expires_in_days: 7,
      });
      setInvitations((prev) => [invitation, ...prev]);
      setInviteEmail("");
      setInviteName("");
      const url = absoluteInviteUrl(invitation.invite_url);
      if (url) {
        await navigator.clipboard?.writeText(url).catch(() => undefined);
        setMessage("邀请已创建，链接已复制");
      } else {
        setMessage("邀请已创建");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "邀请失败");
    } finally {
      setBusy(false);
    }
  };

  const copyInvite = async (invitation: TenantInvitation) => {
    const url = absoluteInviteUrl(invitation.invite_url);
    if (!url) {
      setMessage("只有创建或重发后才会返回一次性邀请链接");
      return;
    }
    await navigator.clipboard?.writeText(url).catch(() => undefined);
    setMessage("邀请链接已复制");
  };

  const resendInvite = async (id: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const invitation = await resendTenantInvitation(id);
      await reloadInvitations();
      const url = absoluteInviteUrl(invitation.invite_url);
      if (url) await navigator.clipboard?.writeText(url).catch(() => undefined);
      setMessage("邀请已重发，链接已复制");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "重发失败");
    } finally {
      setBusy(false);
    }
  };

  const revokeInvite = async (id: string) => {
    if (!confirm("确定撤销这条邀请吗？")) return;
    setBusy(true);
    setMessage(null);
    try {
      await revokeTenantInvitation(id);
      await reloadInvitations();
      setMessage("邀请已撤销");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "撤销失败");
    } finally {
      setBusy(false);
    }
  };

  const pendingInvitations = invitations.filter((item) => item.status === "pending");

  return (
    <>
      <Topbar title="用户管理" />

      <div className="dm-admin-content">
        <Panel title="邀请用户" action={<Badge tone="neutral">租户范围</Badge>}>
          <div className="dm-filter-bar">
            <label className="dm-form-field">
              <span>邮箱</span>
              <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="name@company.com" />
            </label>
            <label className="dm-form-field">
              <span>姓名</span>
              <input value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="可选" />
            </label>
            <label className="dm-form-field">
              <span>角色</span>
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                <option value="end_user">普通用户</option>
                <option value="viewer">只读用户</option>
                <option value="tenant_admin">租户管理员</option>
              </select>
            </label>
            <Button icon={<Send size={14} />} disabled={busy || !inviteEmail.trim()} onClick={createInvite}>
              邀请
            </Button>
          </div>
          {message ? <div className="dm-empty-state" style={{ padding: "10px 0" }}>{message}</div> : null}
        </Panel>

        <div style={{ alignItems: "center", display: "flex", gap: 12, margin: "16px 0" }}>
          <SearchInput placeholder="搜索用户..." value={query} onChange={(e) => setQuery(e.target.value)} />
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>共 {filtered.length} 位用户</span>
        </div>

        <Panel title="Users" action={<Badge tone="neutral">只读</Badge>}>
          <div className="dm-table-head dm-user-row">
            <span>用户</span>
            <span>角色</span>
            <span>可访问知识库</span>
            <span>问答数</span>
            <span>状态</span>
          </div>
          {filtered.map((user) => (
            <div className="dm-user-row" key={user.id}>
              <div className="dm-user-cell">
                <span className="dm-avatar">
                  <User size={14} />
                </span>
                <span>
                  <strong>{user.name || user.email}</strong>
                  <small>{user.email}</small>
                </span>
              </div>
              <span>{user.roles.map(roleLabel).join(", ")}</span>
              <span>{user.allowed_kb_names.join(", ") || "—"}</span>
              <span>{user.query_count}</span>
              <span>
                <Badge tone={user.status === "active" ? "success" : "neutral"}>
                  {user.status === "active" ? "启用中" : user.status}
                </Badge>
              </span>
            </div>
          ))}
          {filtered.length === 0 ? <div className="dm-empty-state">没有匹配的用户</div> : null}
        </Panel>

        <Panel title="待处理邀请" action={<Badge tone="neutral">{pendingInvitations.length}</Badge>}>
          <div className="dm-table-head dm-user-row">
            <span>邮箱</span>
            <span>角色</span>
            <span>过期时间</span>
            <span>状态</span>
            <span>操作</span>
          </div>
          {invitations.map((invitation) => (
            <div className="dm-user-row" key={invitation.id}>
              <span>{invitation.email}</span>
              <span>{invitation.roles.map(roleLabel).join(", ")}</span>
              <span>{new Date(invitation.expires_at).toLocaleString()}</span>
              <span>
                <Badge tone={invitation.status === "pending" ? "warning" : invitation.status === "accepted" ? "success" : "neutral"}>
                  {invitation.status}
                </Badge>
              </span>
              <span style={{ display: "flex", gap: 8 }}>
                <button className="dm-row-action" disabled={!invitation.invite_url} onClick={() => copyInvite(invitation)} title="复制链接" type="button">
                  <Copy size={14} />
                </button>
                <button className="dm-row-action" disabled={busy || invitation.status !== "pending"} onClick={() => resendInvite(invitation.id)} title="重发" type="button">
                  <RotateCw size={14} />
                </button>
                <button className="dm-row-action danger" disabled={busy || invitation.status !== "pending"} onClick={() => revokeInvite(invitation.id)} title="撤销" type="button">
                  <Trash2 size={14} />
                </button>
              </span>
            </div>
          ))}
          {invitations.length === 0 ? <div className="dm-empty-state">暂无邀请</div> : null}
        </Panel>
      </div>
    </>
  );
}
