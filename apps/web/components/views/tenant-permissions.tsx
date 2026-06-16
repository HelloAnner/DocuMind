"use client";

import { useEffect, useState } from "react";
import { Panel } from "@/components/ui/panel";
import { Topbar } from "@/components/ui/topbar";
import { fetchJson } from "@/lib/api";

interface KnowledgeAuthorization {
  id: string;
  knowledgeBase: string;
  target: string;
  permission: "read" | "write" | "manage";
}

const mockAuthorizations: KnowledgeAuthorization[] = [
  { id: "1", knowledgeBase: "产品文档库", target: "role:end_user", permission: "read" },
  { id: "2", knowledgeBase: "销售资料库", target: "user:li@corp.com", permission: "write" },
  { id: "3", knowledgeBase: "研发规范库", target: "dept:研发", permission: "read" },
  { id: "4", knowledgeBase: "人力资源库", target: "group:HR", permission: "manage" },
];

const penRoles = ["owner", "admin", "user", "viewer"] as const;
const penPermissions = [
  "kb.create",
  "document.upload",
  "document.delete",
  "chat.ask",
  "answer.feedback",
  "audit.read",
];

const penMatrix: Record<string, boolean[]> = {
  "kb.create": [true, true, false, false],
  "document.upload": [true, true, false, false],
  "document.delete": [true, true, false, false],
  "chat.ask": [true, true, true, false],
  "answer.feedback": [true, true, true, false],
  "audit.read": [true, true, false, false],
};

export function TenantPermissions() {
  const [activeTab, setActiveTab] = useState<"auth" | "matrix">("auth");
  const [authorizations, setAuthorizations] = useState<KnowledgeAuthorization[]>(mockAuthorizations);
  const [matrix, setMatrix] = useState<Record<string, boolean[]>>(penMatrix);

  useEffect(() => {
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
      .catch(() => setMatrix(penMatrix));
  }, []);

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
            <div className="dm-table-head dm-permission-row">
              <span>知识库</span>
              <span>授权对象</span>
              <span>权限</span>
              <span>操作</span>
            </div>
            {authorizations.map((a) => (
              <div className="dm-permission-row" key={a.id}>
                <span>{a.knowledgeBase}</span>
                <span>{a.target}</span>
                <span>{a.permission}</span>
                <div className="dm-row-actions">
                  <button className="dm-button ghost" style={{ height: 28, padding: "0 8px", fontSize: 12 }}>
                    编辑
                  </button>
                  <button
                    className="dm-button ghost"
                    style={{ height: 28, padding: "0 8px", fontSize: 12, color: "var(--color-error)" }}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
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
