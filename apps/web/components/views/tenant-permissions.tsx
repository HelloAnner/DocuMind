"use client";

import { useEffect, useState } from "react";
import { ShieldPlus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Topbar } from "@/components/ui/topbar";
import {
  grantKnowledgeBasePermission,
  listAdminKnowledgeBases,
  listAdminMembers,
  listAdminPermissions,
  revokeKnowledgeBasePermission,
  type AdminMember,
  type KnowledgeBase,
  type KnowledgeBaseAuthorization,
  type KnowledgeBasePermission,
  type PermissionSubjectType,
  fetchJson,
} from "@/lib/api";

const penRoles = ["owner", "admin", "user", "viewer"] as const;
const penPermissions = [
  "kb.create",
  "kb.manage",
  "document.upload",
  "document.delete",
  "chat.ask",
  "answer.feedback",
  "audit.read",
];

const penMatrix: Record<string, boolean[]> = {
  "kb.create": [true, true, false, false],
  "kb.manage": [true, true, false, false],
  "document.upload": [true, true, false, false],
  "document.delete": [true, true, false, false],
  "chat.ask": [true, true, true, false],
  "answer.feedback": [true, true, true, false],
  "audit.read": [true, true, false, false],
};

const roleOptions = [
  "tenant_admin",
  "team_admin",
  "data_admin",
  "end_user",
  "user",
  "analyst",
  "viewer",
];

const permissionLabels: Record<KnowledgeBasePermission, string> = {
  read: "读取",
  write: "写入",
  manage: "管理",
};

export function TenantPermissions() {
  const [activeTab, setActiveTab] = useState<"auth" | "matrix">("auth");
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [authorizations, setAuthorizations] = useState<KnowledgeBaseAuthorization[]>([]);
  const [matrix, setMatrix] = useState<Record<string, boolean[]>>(penMatrix);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{
    kbId: string;
    subjectType: PermissionSubjectType;
    subjectId: string;
    permission: KnowledgeBasePermission;
  }>({
    kbId: "",
    subjectType: "role",
    subjectId: "end_user",
    permission: "read",
  });

  useEffect(() => {
    Promise.all([listAdminKnowledgeBases(), listAdminMembers(), listAdminPermissions()])
      .then(([kbs, users, acl]) => {
        setKnowledgeBases(kbs);
        setMembers(users);
        setAuthorizations(acl);
        setForm((prev) => ({
          ...prev,
          kbId: prev.kbId || kbs[0]?.id || "",
        }));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "权限数据加载失败"))
      .finally(() => setLoading(false));

    fetchJson<{ roles: Record<string, string[]> }>("/api/v1/permission/matrix")
      .then((res) => {
        const transformed: Record<string, boolean[]> = {};
        for (const perm of penPermissions) {
          transformed[perm] = penRoles.map((role) => {
            const mappedRole = role === "owner" ? "tenant_owner" : role === "admin" ? "tenant_admin" : role;
            return (res.roles[mappedRole] ?? []).includes(perm);
          });
        }
        setMatrix(transformed);
      })
      .catch(() => setMatrix({}));
  }, []);

  const subjectOptions =
    form.subjectType === "role"
      ? roleOptions.map((role) => ({ value: role, label: `role:${role}` }))
      : members
          .filter((member) => member.status === "active")
          .map((member) => ({
            value: member.id,
            label: `user:${member.name || member.email}`,
          }));

  const updateSubjectType = (subjectType: PermissionSubjectType) => {
    setForm((prev) => ({
      ...prev,
      subjectType,
      subjectId:
        subjectType === "role"
          ? "end_user"
          : members.find((member) => member.status === "active")?.id || "",
    }));
  };

  const grant = async () => {
    if (!form.kbId || !form.subjectId) {
      setError("请选择知识库和授权对象");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const granted = await grantKnowledgeBasePermission({
        kb_id: form.kbId,
        subject_type: form.subjectType,
        subject_id: form.subjectId,
        permission: form.permission,
      });
      setAuthorizations((prev) => {
        const rest = prev.filter((item) => item.id !== granted.id);
        return [...rest, granted].sort((a, b) =>
          `${a.kb_name}:${a.subject_type}:${a.subject_label}:${a.permission}`.localeCompare(
            `${b.kb_name}:${b.subject_type}:${b.subject_label}:${b.permission}`
          )
        );
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "授权失败");
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (id: string) => {
    setSaving(true);
    setError(null);
    try {
      await revokeKnowledgeBasePermission(id);
      setAuthorizations((prev) => prev.filter((item) => item.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "撤销授权失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Topbar title="权限策略" />

      <div className="dm-admin-content">
        <div className="dm-tabs" style={{ marginBottom: 16 }}>
          <button
            className={activeTab === "auth" ? "active" : ""}
            onClick={() => setActiveTab("auth")}
            type="button"
          >
            知识库授权
          </button>
          <button
            className={activeTab === "matrix" ? "active" : ""}
            onClick={() => setActiveTab("matrix")}
            type="button"
          >
            角色矩阵
          </button>
        </div>

        {activeTab === "auth" && (
          <Panel title="知识库授权">
            <div className="dm-permission-form">
              <label className="dm-form-field">
                <span>知识库</span>
                <select
                  value={form.kbId}
                  onChange={(event) => setForm((prev) => ({ ...prev, kbId: event.target.value }))}
                >
                  {knowledgeBases.map((kb) => (
                    <option key={kb.id} value={kb.id}>
                      {kb.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="dm-form-field">
                <span>对象类型</span>
                <select
                  value={form.subjectType}
                  onChange={(event) => updateSubjectType(event.target.value as PermissionSubjectType)}
                >
                  <option value="role">角色</option>
                  <option value="user">用户</option>
                </select>
              </label>
              <label className="dm-form-field">
                <span>授权对象</span>
                <select
                  value={form.subjectId}
                  onChange={(event) => setForm((prev) => ({ ...prev, subjectId: event.target.value }))}
                >
                  {subjectOptions.map((subject) => (
                    <option key={subject.value} value={subject.value}>
                      {subject.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="dm-form-field">
                <span>权限</span>
                <select
                  value={form.permission}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, permission: event.target.value as KnowledgeBasePermission }))
                  }
                >
                  <option value="read">读取</option>
                  <option value="write">写入</option>
                  <option value="manage">管理</option>
                </select>
              </label>
              <Button icon={<ShieldPlus size={14} />} onClick={() => grant().catch(console.error)} disabled={saving || loading}>
                授权
              </Button>
            </div>
            {error ? <div className="dm-form-note" style={{ color: "var(--color-error)" }}>{error}</div> : null}
            <div className="dm-table-head dm-permission-row">
              <span>知识库</span>
              <span>授权对象</span>
              <span>权限</span>
              <span>操作</span>
            </div>
            {loading ? <div className="dm-empty-state">加载授权记录中...</div> : null}
            {authorizations.map((a) => (
              <div className="dm-permission-row" key={a.id}>
                <span>{a.kb_name}</span>
                <span>{a.subject_type}:{a.subject_label}</span>
                <span>
                  <Badge tone={a.permission === "manage" ? "warning" : a.permission === "write" ? "info" : "neutral"}>
                    {permissionLabels[a.permission]}
                  </Badge>
                </span>
                <div className="dm-row-actions">
                  <Button
                    variant="ghost"
                    icon={<Trash2 size={13} />}
                    onClick={() => revoke(a.id).catch(console.error)}
                    disabled={saving}
                    style={{ height: 28, padding: "0 8px", fontSize: 12, color: "var(--color-error)" }}
                  >
                    撤销
                  </Button>
                </div>
              </div>
            ))}
            {!loading && authorizations.length === 0 ? <div className="dm-empty-state">暂无知识库授权记录</div> : null}
          </Panel>
        )}

        {activeTab === "matrix" && (
          <Panel title="角色矩阵">
            <div className="dm-table-head dm-matrix-row">
              <span>权限</span>
              {penRoles.map((r) => (
                <span key={r}>{r}</span>
              ))}
            </div>
            {penPermissions.map((perm) => (
              <div className="dm-matrix-row" key={perm}>
                <span>{perm}</span>
                {matrix[perm]?.map((allowed, idx) => (
                  <span key={idx}>{allowed ? "✓" : "✗"}</span>
                ))}
              </div>
            ))}
          </Panel>
        )}
      </div>
    </>
  );
}
