"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Lock, RotateCcw, Unlock } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { Topbar } from "@/components/ui/topbar";
import { SearchInput } from "@/components/ui/search-input";
import { Segmented } from "@/components/ui/segmented";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchJson } from "@/lib/api";
import styles from "./tenant-permissions.module.css";

/* 权限模型（人员 × 权限实体 × 查看/编辑/管理），数据来自本系统 /api/v1/rbac。 */

type RbacActionKey = "view" | "edit" | "manage";
type RbacEffect = "allow" | "deny";
interface RbacEntity {
  type: string;
  id: string;
  label: string;
  actions: RbacActionKey[];
  parent_id?: string;
}
interface RbacCatalog {
  system: string;
  entities: RbacEntity[];
}
interface RbacSubject {
  id: string;
  username: string;
  name?: string;
  role: string;
  roles?: string[];
  status: string;
  managed?: boolean;
}
interface RbacCell {
  type: string;
  id: string;
  action: RbacActionKey;
  allow: boolean;
  source: "role" | "allow" | "deny";
}
interface RbacMatrix {
  subject: RbacSubject;
  baseline_label: string;
  cells: RbacCell[];
  gates?: { type: string; id?: string; action: RbacActionKey; allow: boolean }[];
}

const ACTIONS: { key: RbacActionKey; label: string }[] = [
  { key: "view", label: "查看" },
  { key: "edit", label: "编辑" },
  { key: "manage", label: "管理" },
];
const TYPE_LABEL: Record<string, string> = {
  feature: "功能权限",
  kb: "知识库",
  project: "项目",
  datasource: "数据源",
  table: "数据表",
};
const ROLE_LABEL: Record<string, string> = {
  tenant_owner: "拥有者",
  tenant_admin: "租户管理员",
  enterprise_admin: "企业管理员",
  end_user: "普通用户",
  user: "普通用户",
  viewer: "只读",
};

function groupKey(entity: RbacEntity): string {
  if (entity.type === "feature") return "feature";
  if (entity.type === "table" && entity.parent_id) return `table:${entity.parent_id}`;
  return `type:${entity.type}`;
}

function groupLabel(key: string, catalog: RbacCatalog | null): string {
  if (key === "feature") return "功能权限";
  if (key.startsWith("table:")) {
    const parent = key.slice("table:".length);
    const parentEntity = catalog?.entities.find((item) => item.id === parent && item.type !== "table");
    return `${parentEntity?.label ?? parent} · 数据表`;
  }
  return TYPE_LABEL[key.slice("type:".length)] ?? key;
}

/** 租户设置 → 权限管理：原生实现，人员 × 权限类型 tab × 查看/编辑/管理。 */
export function TenantPermissions() {
  const { me } = useAuth();
  const readOnly = me ? !me.roles.some((role) => ["tenant_admin", "tenant_owner", "enterprise_admin"].includes(role)) : true;

  const [catalog, setCatalog] = useState<RbacCatalog | null>(null);
  const [subjects, setSubjects] = useState<RbacSubject[]>([]);
  const [matrix, setMatrix] = useState<RbacMatrix | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [groupTab, setGroupTab] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const matricesRef = useRef(new Map<string, RbacMatrix>());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = (type: "success" | "error", message: string) => {
    setNotice({ type, message });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3200);
  };

  const loadMatrix = async (subjectId: string, force = false) => {
    if (!force) {
      const cached = matricesRef.current.get(subjectId);
      if (cached) {
        setMatrix(cached);
        return;
      }
    }
    setMatrix(null);
    try {
      const result = await fetchJson<RbacMatrix>(`/api/v1/rbac/matrix?subject_id=${encodeURIComponent(subjectId)}`);
      matricesRef.current.set(subjectId, result);
      setMatrix(result);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "权限矩阵加载失败");
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [catalogResult, subjectResult] = await Promise.all([
          fetchJson<RbacCatalog>("/api/v1/rbac/catalog"),
          fetchJson<{ items: RbacSubject[] }>("/api/v1/rbac/subjects"),
        ]);
        if (cancelled) return;
        setCatalog(catalogResult);
        setSubjects(subjectResult.items);
        const first = subjectResult.items[0]?.id ?? null;
        setSelectedId(first);
        if (first) await loadMatrix(first);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "权限数据加载失败");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectSubject = (subjectId: string) => {
    if (subjectId === selectedId) return;
    setSelectedId(subjectId);
    setMatrix(null);
    void loadMatrix(subjectId);
  };

  const setEffect = async (entity: RbacEntity, action: RbacActionKey, effect: RbacEffect | null) => {
    if (!matrix || readOnly) return;
    const key = `${entity.type}|${entity.id}|${action}`;
    if (pending.has(key)) return;
    setPending((prev) => new Set(prev).add(key));
    try {
      const result = await fetchJson<{ cell: RbacCell }>("/api/v1/rbac/matrix", {
        method: "PUT",
        body: JSON.stringify({ subject_id: matrix.subject.id, type: entity.type, id: entity.id, action, effect }),
      });
      // 功能/数据源变更会影响后代或闸门，整表重载；其余只更新一格。
      if (entity.type === "feature" || entity.type === "datasource") {
        matricesRef.current.delete(matrix.subject.id);
        await loadMatrix(matrix.subject.id, true);
      } else {
        setMatrix((prev) => {
          if (!prev) return prev;
          const cells = [...prev.cells];
          const index = cells.findIndex(
            (cell) => cell.type === entity.type && cell.id === entity.id && cell.action === action,
          );
          if (index >= 0) cells[index] = result.cell;
          else cells.push(result.cell);
          const next = { ...prev, cells };
          matricesRef.current.set(prev.subject.id, next);
          return next;
        });
      }
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "保存失败，已恢复");
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const toggleCell = (entity: RbacEntity, action: RbacActionKey, cell: RbacCell | undefined) => {
    const allow = cell?.allow ?? false;
    const source = cell?.source ?? "role";
    let effect: RbacEffect | null;
    if (allow) effect = "deny";
    else if (source === "deny" || source === "allow") effect = null;
    else effect = "allow";
    void setEffect(entity, action, effect);
  };

  const resetAll = async () => {
    if (!matrix || readOnly) return;
    const subject = matrix.subject;
    if (!window.confirm(`把 ${subject.name || subject.username} 的全部个人设置恢复为角色默认？`)) return;
    try {
      const result = await fetchJson<{ removed: number }>(
        `/api/v1/rbac/matrix?subject_id=${encodeURIComponent(subject.id)}`,
        { method: "DELETE" },
      );
      matricesRef.current.delete(subject.id);
      await loadMatrix(subject.id, true);
      notify("success", `已恢复 ${result.removed} 项个人设置`);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "恢复默认失败");
    }
  };

  /* ---------- 衍生数据 ---------- */

  const cellLookup = new Map<string, RbacCell>();
  for (const cell of matrix?.cells ?? []) cellLookup.set(`${cell.type}|${cell.id}|${cell.action}`, cell);

  const gateFor = (entity: RbacEntity, action: RbacActionKey): boolean => {
    const gate = matrix?.gates?.find(
      (item) => item.type === entity.type && (item.id === undefined || item.id === entity.id) && item.action === action,
    );
    return gate ? gate.allow : true;
  };

  const grouped = new Map<string, RbacEntity[]>();
  for (const entity of catalog?.entities ?? []) {
    const key = groupKey(entity);
    const list = grouped.get(key);
    if (list) list.push(entity);
    else grouped.set(key, [entity]);
  }
  const groupKeys = [...grouped.keys()].sort((a, b) => {
    const rank = (key: string) => (key === "feature" ? 0 : key.startsWith("table:") ? 2 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const activeGroup = groupTab && grouped.has(groupTab) ? groupTab : grouped.has("feature") ? "feature" : groupKeys[0] ?? null;

  const keyword = search.trim().toLowerCase();
  const filteredSubjects = subjects.filter((subject) => {
    if (!keyword) return true;
    return [subject.name, subject.username, subject.role].some((value) =>
      (value ?? "").toLowerCase().includes(keyword),
    );
  });

  const renderLockCell = (entity: RbacEntity, action: (typeof ACTIONS)[number]) => {
    if (!entity.actions.includes(action.key)) {
      return (
        <span key={action.key} className={styles.none}>
          —
        </span>
      );
    }
    const cell = cellLookup.get(`${entity.type}|${entity.id}|${action.key}`);
    const allow = cell?.allow ?? false;
    const overridden = cell?.source === "allow" || cell?.source === "deny";
    const gate = gateFor(entity, action.key);
    const disabled = readOnly || !gate || pending.has(`${entity.type}|${entity.id}|${action.key}`) || !matrix;
    return (
      <span key={action.key} className={styles.cell}>
        <button
          type="button"
          role="switch"
          aria-checked={allow}
          aria-label={`${entity.label} · ${action.label}权限`}
          title={
            readOnly
              ? "只有管理员可以调整权限"
              : !gate
                ? "该成员的角色不具备此功能，资源授权不会生效"
                : `${action.label}：${allow ? "允许" : "拒绝"}${overridden ? "（个人设置）" : "（角色默认）"}，点击切换`
          }
          disabled={disabled}
          onClick={() => toggleCell(entity, action.key, cell)}
          className={`${styles.lock}${allow ? ` ${styles.lockOn}` : ""}`}
        >
          {allow ? <Unlock size={11} /> : <Lock size={11} />}
          {overridden && <span className={styles.overrideDot} />}
        </button>
        {overridden && !readOnly && (
          <button
            type="button"
            title="恢复角色默认"
            aria-label={`${entity.label} · ${action.label} · 恢复角色默认`}
            onClick={(event) => {
              event.stopPropagation();
              void setEffect(entity, action.key, null);
            }}
            className={styles.cellReset}
          >
            <RotateCcw size={8} />
          </button>
        )}
      </span>
    );
  };

  /* ---------- 渲染 ---------- */

  return (
    <>
      <Topbar
        title="权限管理"
        subtitle="左侧选择成员，右侧用锁开关调整各权限实体的查看、编辑与管理权限"
      />
      <div className="dm-admin-content dm-settings-page">
        {notice && (
          <div className={`${styles.notice} ${notice.type === "success" ? styles.noticeSuccess : styles.noticeError}`}>
            {notice.type === "success" ? <Check size={14} /> : <AlertCircle size={14} />}
            {notice.message}
          </div>
        )}
        {loadError ? (
          <div className={styles.empty}>{loadError}</div>
        ) : !catalog ? (
          <div className={styles.empty}>正在加载权限…</div>
        ) : (
          <div className={styles.layout}>
            {/* 左：成员 */}
            <aside className={styles.people}>
              <SearchInput
                placeholder="搜索成员"
                aria-label="搜索成员"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className={styles.peopleList}>
                {filteredSubjects.length === 0 && (
                  <div className={styles.empty}>
                    {subjects.length === 0 ? "该系统中还没有成员" : "没有匹配的成员"}
                  </div>
                )}
                {filteredSubjects.map((subject) => {
                  const active = subject.id === selectedId;
                  const role = subject.role || subject.roles?.[0] || "user";
                  return (
                    <button
                      key={subject.id}
                      type="button"
                      onClick={() => selectSubject(subject.id)}
                      className={`${styles.person}${active ? ` ${styles.personActive}` : ""}`}
                    >
                      <span className={`${styles.avatar}${active ? ` ${styles.avatarActive}` : ""}`}>
                        {(subject.name || subject.username || "?").charAt(0).toUpperCase()}
                      </span>
                      <span className={styles.personMain}>
                        <span className={styles.personName}>{subject.name || subject.username}</span>
                        <span className={styles.personMeta}>{subject.username}</span>
                      </span>
                      <Badge tone={role === "tenant_admin" || role === "tenant_owner" ? "info" : "neutral"}>
                        {ROLE_LABEL[role] ?? role}
                      </Badge>
                      <span
                        title={subject.status === "active" ? "正常" : "已停用"}
                        className={`${styles.status}${subject.status === "active" ? "" : ` ${styles.statusOff}`}`}
                      />
                    </button>
                  );
                })}
              </div>
              <div className={styles.peopleFoot}>
                共 {subjects.length} 人{search ? `，匹配 ${filteredSubjects.length} 人` : ""}
              </div>
            </aside>

            {/* 右：权限明细 */}
            <section className={styles.detail}>
              {!matrix ? (
                <div className={styles.empty}>{selectedId ? "正在加载权限…" : "请选择左侧成员"}</div>
              ) : (
                <>
                  <div className={styles.detailHead}>
                    <div className={styles.detailTitle}>
                      <span className={styles.detailName}>{matrix.subject.name || matrix.subject.username}</span>
                      <span className={styles.detailSub}>
                        {matrix.subject.username} · {matrix.baseline_label}
                        {matrix.subject.managed === false ? " · 仅本系统账号" : ""}
                      </span>
                    </div>
                    {!readOnly && (
                      <Button variant="secondary" icon={<RotateCcw size={12} />} onClick={() => void resetAll()}>
                        全部恢复默认
                      </Button>
                    )}
                  </div>

                  <div className={styles.legend}>
                    <b>
                      <span className={`${styles.legendLock} ${styles.legendLockOn}`}>
                        <Unlock size={9} />
                      </span>
                      允许
                    </b>
                    <b>
                      <span className={styles.legendLock}>
                        <Lock size={9} />
                      </span>
                      拒绝
                    </b>
                    <b>
                      <span className={styles.miniDot} />
                      个人设置（无点=角色默认）
                    </b>
                  </div>

                  <Segmented
                    className={styles.types}
                    options={groupKeys.map((key) => ({
                      value: key,
                      label: `${groupLabel(key, catalog)} ${grouped.get(key)?.length ?? 0}`,
                    }))}
                    value={activeGroup ?? ""}
                    onChange={(key) => setGroupTab(key)}
                  />

                  {activeGroup && (
                    <div className={styles.table}>
                      <div className={styles.tableHead}>
                        <span className={styles.colName}>名称</span>
                        {ACTIONS.map((action) => (
                          <span key={action.key} className={styles.colHead}>
                            {action.label}
                          </span>
                        ))}
                      </div>
                      {(grouped.get(activeGroup) ?? []).map((entity) => (
                        <div key={`${entity.type}:${entity.id}`} className={styles.row}>
                          <span
                            className={styles.entity}
                            style={{ paddingLeft: activeGroup.startsWith("table:") ? 14 : 0 }}
                          >
                            <span className={styles.entityName} title={entity.label}>
                              {entity.label}
                            </span>
                            {entity.type === "feature" && <span className={styles.entityTag}>功能</span>}
                          </span>
                          {ACTIONS.map((action) => renderLockCell(entity, action))}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </>
  );
}
