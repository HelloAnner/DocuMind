"use client";

import { useAuth } from "@/components/providers/auth-provider";
import { RbacPanelHost } from "@/components/rbac-panel-host";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson } from "@/lib/api";
import type { RbacAdapter, RbacCatalog, RbacMatrix, RbacSubject } from "@/lib/rbac/panel";

const adapter: RbacAdapter = {
  loadCatalog: () => fetchJson<RbacCatalog>("/api/v1/rbac/catalog"),
  loadSubjects: () =>
    fetchJson<{ items: RbacSubject[] }>("/api/v1/rbac/subjects"),
  loadMatrix: (subjectId) =>
    fetchJson<RbacMatrix>(`/api/v1/rbac/matrix?subject_id=${encodeURIComponent(subjectId)}`),
  setCell: (input) =>
    fetchJson<{ cell: RbacMatrix["cells"][number] }>("/api/v1/rbac/matrix", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  resetAll: (subjectId) =>
    fetchJson<{ removed: number }>(
      `/api/v1/rbac/matrix?subject_id=${encodeURIComponent(subjectId)}`,
      { method: "DELETE" },
    ),
};

/** 租户设置 → 权限管理：人员 × 权限实体 × 查看/编辑/管理。 */
export function TenantPermissions() {
  const { me } = useAuth();
  const readOnly = me ? !me.roles.some((role) => ["tenant_admin", "tenant_owner", "enterprise_admin"].includes(role)) : true;

  return (
    <>
      <Topbar
        title="权限管理"
        subtitle="左侧选择成员，右侧用锁开关调整各权限实体的查看、编辑与管理权限"
      />
      <div className="dm-admin-content dm-settings-page">
        <RbacPanelHost adapter={adapter} readOnly={readOnly} />
      </div>
    </>
  );
}
