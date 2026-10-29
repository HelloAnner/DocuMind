"use client";

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { AlertCircle, Check, ChevronRight, Lock, RotateCcw, Search, Unlock } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { fetchJson } from "@/lib/api";
import styles from "./tenant-permissions.module.css";

/* 权限模型（人员 × 权限实体 × 查看/编辑/管理），数据来自本系统 /api/v1/rbac。 */

type RbacActionKey = "view" | "edit" | "manage";
type RbacEffect = "allow" | "deny";
type Mode = "quick" | "final";

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
interface PermGroup {
  key: string;
  label: string;
  entities: RbacEntity[];
  children: Map<string, RbacEntity[]>;
  count: number;
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
  datasource: "数据连接",
  table: "数据表",
};
const ROLE_LABEL: Record<string, string> = {
  tenant_owner: "拥有者",
  tenant_admin: "租户管理员",
  enterprise_admin: "企业管理员",
  super_admin: "超级管理员",
  team_admin: "团队管理员",
  center_director: "中心主任",
  end_user: "普通用户",
  user: "普通用户",
  viewer: "只读",
};

function buildGroups(entities: RbacEntity[]): PermGroup[] {
  const groups: PermGroup[] = [];
  const index = new Map<string, PermGroup>();
  const get = (key: string, label: string): PermGroup => {
    const found = index.get(key);
    if (found) return found;
    const group: PermGroup = { key, label, entities: [], children: new Map(), count: 0 };
    index.set(key, group);
    groups.push(group);
    return group;
  };
  for (const entity of entities) {
    const key =
      entity.type === "table" && entity.parent_id
        ? "datasource"
        : entity.type === "feature"
          ? "feature"
          : entity.type;
    const group = get(key, TYPE_LABEL[key] ?? TYPE_LABEL[entity.type] ?? entity.type);
    group.count += 1;
    if (entity.type === "table" && entity.parent_id) {
      const list = group.children.get(entity.parent_id);
      if (list) list.push(entity);
      else group.children.set(entity.parent_id, [entity]);
    } else {
      group.entities.push(entity);
    }
  }
  const rank = (key: string) => (key === "feature" ? 0 : key === "kb" ? 1 : key === "project" ? 2 : key === "datasource" ? 3 : 4);
  return groups.sort((a, b) => rank(a.key) - rank(b.key));
}

/** 租户设置 → 权限管理：人员名单 + 目录权限矩阵。 */
export function TenantPermissions() {
  const { me } = useAuth();
  const canWrite = me
    ? me.roles.some((role) => ["tenant_admin", "tenant_owner", "enterprise_admin"].includes(role))
    : false;

  const [catalog, setCatalog] = useState<RbacCatalog | null>(null);
  const [subjects, setSubjects] = useState<RbacSubject[]>([]);
  const [matrix, setMatrix] = useState<RbacMatrix | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("quick");
  const [search, setSearch] = useState("");
  const [entitySearch, setEntitySearch] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [groupTab, setGroupTab] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const matricesRef = useRef(new Map<string, RbacMatrix>());
  const selectedIdRef = useRef<string | null>(null);
  const matrixRequest = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const readOnly = mode === "final" || !canWrite;

  const notify = (type: "success" | "error", message: string) => {
    setNotice({ type, message });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3200);
  };

  const loadMatrix = async (subjectId: string, force = false) => {
    if (selectedIdRef.current !== subjectId) return;
    const request = ++matrixRequest.current;
    if (!force) {
      const cached = matricesRef.current.get(subjectId);
      if (cached) {
        setMatrix(cached);
        return;
      }
    }
    // 重载（force）时保留旧表格直到新数据到达，避免页面闪动。
    setMatrix((prev) => (prev && prev.subject.id === subjectId ? prev : null));
    try {
      const result = await fetchJson<RbacMatrix>(`/api/v1/rbac/matrix?subject_id=${encodeURIComponent(subjectId)}`);
      if (request !== matrixRequest.current || selectedIdRef.current !== subjectId) return;
      matricesRef.current.set(subjectId, result);
      setMatrix(result);
    } catch (error) {
      if (request === matrixRequest.current && selectedIdRef.current === subjectId) {
        notify("error", error instanceof Error ? error.message : "权限矩阵加载失败");
      }
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
        selectedIdRef.current = first;
        setSelectedId(first);
        if (first) await loadMatrix(first);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "权限数据加载失败");
      }
    })();
    return () => {
      cancelled = true;
      selectedIdRef.current = null;
      matrixRequest.current += 1;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectSubject = (subjectId: string) => {
    if (subjectId === selectedId) return;
    selectedIdRef.current = subjectId;
    setSelectedId(subjectId);
    setMatrix(null);
    setEntitySearch("");
    void loadMatrix(subjectId);
  };

  const setEffect = async (entity: RbacEntity, action: RbacActionKey, effect: RbacEffect | null) => {
    if (!matrix || readOnly) return;
    const subjectId = matrix.subject.id;
    const key = `${subjectId}|${entity.type}|${entity.id}|${action}`;
    if (pending.has(key)) return;
    setPending((prev) => new Set(prev).add(key));
    try {
      await fetchJson<{ cell: RbacCell }>("/api/v1/rbac/matrix", {
        method: "PUT",
        body: JSON.stringify({ subject_id: subjectId, type: entity.type, id: entity.id, action, effect }),
      });
      // 始终刷新这次操作的人员；切换人员后不把旧响应写入新矩阵。
      matricesRef.current.delete(subjectId);
      await loadMatrix(subjectId, true);
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

  const groups = useMemo(() => buildGroups(catalog?.entities ?? []), [catalog]);
  const activeGroup = groupTab && groups.some((group) => group.key === groupTab) ? groupTab : groups[0]?.key ?? null;
  const currentGroup = groups.find((group) => group.key === activeGroup) ?? null;

  const keyword = search.trim().toLowerCase();
  const filteredSubjects = subjects.filter((subject) => {
    if (!keyword) return true;
    return [subject.name, subject.username, ROLE_LABEL[subject.role] ?? subject.role].some((value) =>
      (value ?? "").toLowerCase().includes(keyword),
    );
  });

  const renderLockCell = (entity: RbacEntity, action: (typeof ACTIONS)[number]) => {
    if (!entity.actions.includes(action.key)) {
      return <span key={action.key} className={styles.none}>—</span>;
    }
    const cell = cellLookup.get(`${entity.type}|${entity.id}|${action.key}`);
    const allow = cell?.allow ?? false;
    const source = cell?.source ?? "role";
    const overridden = source === "allow" || source === "deny";
    const gate = gateFor(entity, action.key);
    const disabled = readOnly || !gate || pending.has(`${matrix?.subject.id}|${entity.type}|${entity.id}|${action.key}`) || !matrix;
    const title = !gate
      ? "该成员的角色不具备此功能，资源授权不会生效"
      : readOnly && !canWrite
        ? "只有管理员可以调整权限"
        : `${action.label}：${allow ? "允许" : "拒绝"}${overridden ? "（个人设置）" : "（角色默认）"}${readOnly ? "" : "，点击切换"}`;
    const icon = allow ? <Lock size={15} /> : <Unlock size={15} />;
    const color = source === "deny" ? styles.lockDeny : allow ? styles.lockOn : styles.lockOff;

    return (
      <span key={action.key} className={styles.cell}>
        {readOnly ? (
          <span title={title} aria-label={`${entity.label} · ${action.label}权限`} className={`${styles.lock} ${styles.lockStatic} ${color}${!gate ? ` ${styles.lockGated}` : ""}`}>
            {icon}
          </span>
        ) : (
          <>
            <button
              type="button"
              role="switch"
              aria-checked={allow}
              aria-label={`${entity.label} · ${action.label}权限`}
              title={title}
              disabled={disabled}
              onClick={() => toggleCell(entity, action.key, cell)}
              className={`${styles.lock} ${color}`}
            >
              {icon}
              {overridden && <span className={styles.overrideDot} />}
            </button>
            {overridden && (
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
          </>
        )}
      </span>
    );
  };

  /* ---------- 表格行 ---------- */

  const renderRows = (): ReactElement[] => {
    if (!currentGroup) return [];
    const kw = entitySearch.trim().toLowerCase();
    const match = (entity: RbacEntity) => !kw || entity.label.toLowerCase().includes(kw);
    const rows: ReactElement[] = [];

    const nameCell = (entity: RbacEntity, depth: number, caret?: ReactNode) => (
      <span className={styles.name} style={{ paddingLeft: depth ? 14 + depth * 22 : 10 }}>
        {caret ?? <span className={styles.caretSpace} />}
        <span className={`${styles.nameText}${depth === 0 && currentGroup.key === "datasource" ? ` ${styles.nameParent}` : ""}`} title={entity.label}>
          {entity.label}
        </span>
      </span>
    );

    if (currentGroup.key === "datasource") {
      for (const parent of currentGroup.entities) {
        const children = (currentGroup.children.get(parent.id) ?? []).filter(match);
        if (!match(parent) && children.length === 0) continue;
        const open = children.length > 0 && (!collapsed.has(parent.id) || Boolean(kw));
        const caret =
          children.length > 0 ? (
            <button
              type="button"
              aria-label={`${open ? "收起" : "展开"} ${parent.label}`}
              aria-expanded={open}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(parent.id)) next.delete(parent.id);
                  else next.add(parent.id);
                  return next;
                })
              }
              className={`${styles.caret}${open ? ` ${styles.caretOpen}` : ""}`}
            >
              <ChevronRight size={12} />
            </button>
          ) : (
            <span className={styles.caretSpace} />
          );
        rows.push(
          <div key={`${parent.type}:${parent.id}`} className={styles.row}>
            <span className={styles.name}>
              {caret}
              <span className={`${styles.nameText} ${styles.nameParent}`} title={parent.label}>{parent.label}</span>
              {children.length > 0 && <span className={styles.tag}>{children.length} 项</span>}
            </span>
            {ACTIONS.map((action) => renderLockCell(parent, action))}
          </div>,
        );
        if (open) {
          for (const child of children) {
            rows.push(
              <div key={`${child.type}:${child.id}`} className={styles.row}>
                {nameCell(child, 1)}
                {ACTIONS.map((action) => renderLockCell(child, action))}
              </div>,
            );
          }
        }
      }
      return rows;
    }

    for (const entity of currentGroup.entities) {
      if (!match(entity)) continue;
      rows.push(
        <div key={`${entity.type}:${entity.id}`} className={styles.row}>
          {nameCell(entity, 0)}
          {ACTIONS.map((action) => renderLockCell(entity, action))}
        </div>,
      );
    }
    return rows;
  };

  const tableRows = renderRows();
  const activeSubject = matrix?.subject ?? subjects.find((subject) => subject.id === selectedId);

  /* ---------- 渲染 ---------- */

  return (
    <div className={`dm-admin-content ${styles.page}`}>
      {notice && (
        <div className={`${styles.notice} ${notice.type === "success" ? styles.noticeSuccess : styles.noticeError}`}>
          {notice.type === "success" ? <Check size={14} /> : <AlertCircle size={14} />}
          {notice.message}
        </div>
      )}

      {/* 顶部模式栏 */}
      <div className={styles.modeBar}>
        <div className={styles.modes} role="tablist" aria-label="权限查看模式">
          {[
            { key: "quick" as const, label: "权限快速配置" },
            { key: "final" as const, label: "用户最终权限" },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={mode === item.key}
              onClick={() => setMode(item.key)}
              className={`${styles.mode}${mode === item.key ? ` ${styles.modeActive}` : ""}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className={styles.dim}>
          <span>当前查看维度：</span>
          <span className={styles.dimValue}>人员维度</span>
          {activeSubject && (
            <>
              <span className={styles.dimSep}>·</span>
              <span className={styles.dimSubject}>{activeSubject.name || activeSubject.username}</span>
            </>
          )}
          {mode === "quick" && matrix && canWrite && (
            <button type="button" onClick={() => void resetAll()} className={styles.link}>
              <RotateCcw size={11} />
              全部恢复默认
            </button>
          )}
        </div>
      </div>

      {loadError ? (
        <div className={styles.empty}>{loadError}</div>
      ) : (
        <div className={styles.body}>
          {/* 左：人员名单 */}
          <aside className={styles.people}>
            <div className={styles.peopleHead}>
              <div className={styles.peopleTitle}>
                <span>人员</span>
                <span className={styles.peopleCount}>{subjects.length}</span>
              </div>
              <div className={styles.search}>
                <Search size={13} />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索人员"
                  aria-label="搜索人员"
                  className={styles.input}
                />
              </div>
            </div>
            <div className={styles.peopleList} role="listbox" aria-label="人员名单">
              {filteredSubjects.length === 0 && (
                <div className={styles.emptyLine}>
                  {subjects.length === 0 ? "该系统中还没有成员" : "没有匹配的人员"}
                </div>
              )}
              {filteredSubjects.map((subject) => {
                const active = subject.id === selectedId;
                const role = subject.role || subject.roles?.[0] || "user";
                return (
                  <button
                    key={subject.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => selectSubject(subject.id)}
                    title={`${subject.name || subject.username} · ${subject.username} · ${ROLE_LABEL[role] ?? role}`}
                    className={`${styles.person}${active ? ` ${styles.personActive}` : ""}`}
                  >
                    <span className={styles.avatar}>{(subject.name || subject.username || "?").charAt(0).toUpperCase()}</span>
                    <span className={styles.personName}>{subject.name || subject.username}</span>
                    <span className={styles.role}>{ROLE_LABEL[role] ?? role}</span>
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

          {/* 右：目录权限 */}
          <section className={styles.main}>
            <div className={styles.toolbar}>
              <div className={styles.groups} role="tablist" aria-label="权限分组">
                {groups.map((group) => (
                  <button
                    key={group.key}
                    type="button"
                    role="tab"
                    aria-selected={group.key === activeGroup}
                    onClick={() => setGroupTab(group.key)}
                    className={`${styles.group}${group.key === activeGroup ? ` ${styles.groupActive}` : ""}`}
                  >
                    {group.label}
                    <span className={styles.groupCount}>{group.count}</span>
                  </button>
                ))}
              </div>
              <div className={styles.toolSearch}>
                <Search size={13} />
                <input
                  type="search"
                  value={entitySearch}
                  onChange={(event) => setEntitySearch(event.target.value)}
                  placeholder="搜索权限项"
                  aria-label="搜索权限项"
                  className={styles.input}
                />
              </div>
            </div>

            <div className={styles.table}>
              {!matrix ? (
                <div className={styles.empty}>{selectedId ? "正在加载权限…" : "请选择左侧人员"}</div>
              ) : (
                <>
                  <div className={styles.thead}>
                    <span className={styles.colName}>所有权限项</span>
                    {ACTIONS.map((action) => (
                      <span key={action.key} className={styles.colAct}>{action.label}</span>
                    ))}
                  </div>
                  {tableRows}
                  {tableRows.length === 0 && (
                    <div className={styles.emptyLine}>{entitySearch ? "没有匹配的权限项" : "暂无权限项"}</div>
                  )}
                </>
              )}
            </div>

            <div className={styles.legend}>
              {mode === "final" && <span className={styles.finalHint}>只读视图：角色默认 + 个人设置后的最终结果</span>}
              <span><Lock size={12} />已授权</span>
              <span><Unlock size={12} />未授权</span>
              <span><i className={styles.legendDot} />个人设置（蓝=额外授权，红=单独拒绝）</span>
              <span>— 此权限项不支持该动作</span>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
