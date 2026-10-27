// 共享 RBAC 面板：无框架 Web Component 风格（light DOM），Portal / Northline /
// DocuMind / NexusFlow 共用。canonical 源在 Portal，另外三个仓库由 Makefile 同步。
//
// 宿主只需要提供 5 个适配函数；组件不读 cookie、不拼 URL、不认识登录方式。
// 三维模型：人员（左） × 权限实体（右，分组） × 查看/编辑/管理（列）。

export const RBAC_PANEL_VERSION = '2026-11-01.1';

export type RbacActionKey = 'view' | 'edit' | 'manage';
export type RbacEffect = 'allow' | 'deny';
export type RbacSource = 'role' | 'allow' | 'deny';
export type SystemState = 'ready' | 'unconfigured' | 'unlinked' | 'error';

export interface RbacAction {
  key: RbacActionKey;
  label: string;
}

export interface RbacEntity {
  type: string;
  id: string;
  label: string;
  actions: RbacActionKey[];
  parent_id?: string;
}

export interface RbacCatalog {
  system: string;
  actions: RbacAction[];
  entities: RbacEntity[];
}

export interface RbacSubject {
  id: string;
  portal_user_id?: string | null;
  username: string;
  name?: string;
  role: string;
  roles?: string[];
  status: string;
  managed?: boolean;
}

export interface RbacCell {
  type: string;
  id: string;
  action: RbacActionKey;
  allow: boolean;
  source: RbacSource;
}

export interface RbacGate {
  type: string;
  /** 功能闸门按实体区分；资源闸门不填 id，作用于该类型全部实体。 */
  id?: string;
  action: RbacActionKey;
  allow: boolean;
}

export interface RbacMatrix {
  subject: RbacSubject;
  baseline_label: string;
  cells: RbacCell[];
  gates?: RbacGate[];
}

export interface RbacSystem {
  code: string;
  label: string;
  state: SystemState;
  reason?: string;
}

export interface RbacSetCellInput {
  subject_id: string;
  type: string;
  id: string;
  action: RbacActionKey;
  effect: RbacEffect | null;
}

export interface RbacAdapter {
  loadCatalog(): Promise<RbacCatalog>;
  loadSubjects(): Promise<{ items: RbacSubject[] } | RbacSubject[]>;
  loadMatrix(subjectId: string): Promise<RbacMatrix>;
  setCell(input: RbacSetCellInput): Promise<{ cell: RbacCell }>;
  resetAll(subjectId: string): Promise<{ removed: number }>;
}

export interface RbacMountOptions {
  adapter: RbacAdapter;
  showSystemTabs?: boolean;
  systems?: RbacSystem[];
  system?: string;
  onSystemChange?: (code: string) => void;
  readOnly?: boolean;
  emptyPeopleText?: string;
}

export interface RbacPanelHandle {
  destroy(): void;
  update(options: Partial<RbacMountOptions>): void;
  reload(): void;
}

type State = {
  options: RbacMountOptions;
  catalog: RbacCatalog | null;
  subjects: RbacSubject[];
  selectedId: string | null;
  matrix: RbacMatrix | null;
  matrices: Map<string, RbacMatrix>;
  loadingCatalog: boolean;
  loadingMatrix: boolean;
  error: string | null;
  detailError: string | null;
  groupOpen: Map<string, boolean>;
  search: string;
  pending: Set<string>;
  toast: string | null;
  toastTimer: number | null;
};

const ACTION_FALLBACK: RbacAction[] = [
  { key: 'view', label: '查看' },
  { key: 'edit', label: '编辑' },
  { key: 'manage', label: '管理' },
];

const TYPE_LABEL: Record<string, string> = {
  feature: '功能权限',
  kb: '知识库',
  project: '项目',
  datasource: '数据源',
  table: '数据表',
};

const STYLE_ID = 'rbac-panel-style';
const CSS = `
.rbac{--rbac-ink:#16161a;--rbac-ink2:#4a4a52;--rbac-muted:#86868f;--rbac-fill:#f5f4f2;--rbac-line:rgba(17,17,17,.08);--rbac-line2:rgba(17,17,17,.18);--rbac-red:#d92d20;--rbac-green:#12855a;--rbac-radius:10px;display:flex;flex-direction:column;min-height:520px;height:100%;color:var(--rbac-ink);font:12.5px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:#fff}
.rbac *{box-sizing:border-box}
.rbac button{font:inherit;color:inherit}
.rbac-tabs{display:flex;gap:4px;padding:0 0 14px;border-bottom:1px solid var(--rbac-line);margin-bottom:16px;flex-wrap:wrap}
.rbac-tab{appearance:none;border:1px solid transparent;background:transparent;border-radius:8px;padding:7px 12px;font-size:12.5px;font-weight:500;color:var(--rbac-muted);cursor:pointer;display:inline-flex;align-items:center;gap:7px;transition:background .15s,color .15s,border-color .15s}
.rbac-tab:hover:not(:disabled){background:var(--rbac-fill);color:var(--rbac-ink2)}
.rbac-tab[aria-selected="true"]{background:var(--rbac-ink);color:#fff}
.rbac-tab:disabled{opacity:.42;cursor:not-allowed}
.rbac-tab-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.55}
.rbac-tab[aria-selected="true"] .rbac-tab-dot{opacity:1}
.rbac-body{display:flex;gap:0;flex:1;min-height:0}
.rbac-people{width:252px;flex:0 0 252px;border-right:1px solid var(--rbac-line);display:flex;flex-direction:column;min-height:0;padding-right:14px}
.rbac-search{position:relative;margin:0 0 10px}
.rbac-search input{width:100%;height:32px;border:1px solid var(--rbac-line);border-radius:8px;background:#fff;padding:0 10px 0 30px;font-size:12.5px;outline:none}
.rbac-search input:focus{border-color:var(--rbac-line2);box-shadow:0 0 0 3px rgba(17,17,17,.04)}
.rbac-search svg{position:absolute;left:9px;top:9px;color:var(--rbac-muted)}
.rbac-people-list{flex:1;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:2px;padding-right:2px}
.rbac-person{appearance:none;border:0;background:transparent;border-radius:8px;padding:8px 8px;display:flex;align-items:center;gap:9px;text-align:left;cursor:pointer;width:100%;transition:background .15s}
.rbac-person:hover{background:var(--rbac-fill)}
.rbac-person[aria-current="true"]{background:rgba(17,17,17,.06)}
.rbac-avatar{width:28px;height:28px;flex:0 0 28px;border-radius:50%;background:var(--rbac-fill);border:1px solid var(--rbac-line);display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:600;color:var(--rbac-ink2)}
.rbac-person[aria-current="true"] .rbac-avatar{background:var(--rbac-ink);border-color:var(--rbac-ink);color:#fff}
.rbac-person-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}
.rbac-person-name{font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rbac-person-meta{font-size:10.5px;color:var(--rbac-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rbac-person-side{display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex:0 0 auto}
.rbac-role{font-size:10px;line-height:1.4;padding:1px 5px;border-radius:4px;background:var(--rbac-fill);color:var(--rbac-ink2);white-space:nowrap}
.rbac-status{width:5px;height:5px;border-radius:50%;background:var(--rbac-green)}
.rbac-status.is-off{background:var(--rbac-muted)}
.rbac-local{font-size:9.5px;color:var(--rbac-muted);border:1px solid var(--rbac-line);border-radius:4px;padding:0 4px}
.rbac-people-foot{border-top:1px solid var(--rbac-line);padding:9px 4px 0;margin-top:8px;font-size:11px;color:var(--rbac-muted)}
.rbac-detail{flex:1;min-width:0;display:flex;flex-direction:column;padding-left:20px;min-height:0}
.rbac-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:0 0 10px}
.rbac-detail-title{display:flex;align-items:center;gap:9px;min-width:0}
.rbac-detail-title h3{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rbac-detail-sub{margin:2px 0 0;font-size:11.5px;color:var(--rbac-muted)}
.rbac-reset-all{appearance:none;border:1px solid var(--rbac-line);background:#fff;border-radius:7px;padding:5px 9px;font-size:11.5px;color:var(--rbac-ink2);cursor:pointer;white-space:nowrap}
.rbac-reset-all:hover{border-color:var(--rbac-line2);background:var(--rbac-fill)}
.rbac-reset-all:disabled{opacity:.45;cursor:not-allowed}
.rbac-legend{display:flex;gap:14px;flex-wrap:wrap;align-items:center;padding:8px 10px;border:1px solid var(--rbac-line);border-radius:8px;background:#fcfcfb;font-size:11px;color:var(--rbac-muted);margin-bottom:12px}
.rbac-legend b{display:inline-flex;align-items:center;gap:5px;font-weight:500;color:var(--rbac-ink2)}
.rbac-legend .rbac-mini-lock{width:15px;height:15px;border-radius:5px;background:var(--rbac-fill);display:inline-flex;align-items:center;justify-content:center;color:var(--rbac-muted)}
.rbac-legend .rbac-mini-lock.on{background:var(--rbac-ink);color:#fff}
.rbac-legend .rbac-mini-dot{width:4px;height:4px;border-radius:50%;background:currentColor;margin-left:1px}
.rbac-groups{flex:1;overflow:auto;min-height:0;padding:0 2px 24px 0}
.rbac-group{border:1px solid var(--rbac-line);border-radius:10px;background:#fff;margin-bottom:10px;overflow:hidden}
.rbac-group-head{display:grid;grid-template-columns:minmax(0,1fr) 58px 58px 58px;align-items:center;gap:0;padding:8px 12px;background:#fcfcfb;border-bottom:1px solid transparent;position:sticky;top:0;z-index:2}
.rbac-group[data-open="true"] .rbac-group-head{border-bottom-color:var(--rbac-line)}
.rbac-group-toggle{appearance:none;border:0;background:transparent;display:flex;align-items:center;gap:7px;padding:0;font-size:12px;font-weight:600;color:var(--rbac-ink);cursor:pointer;text-align:left;min-width:0}
.rbac-group-toggle svg{color:var(--rbac-muted);flex:0 0 auto;transition:transform .15s}
.rbac-group-toggle[aria-expanded="false"] svg{transform:rotate(-90deg)}
.rbac-group-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rbac-count{font-size:10.5px;font-weight:500;color:var(--rbac-muted);margin-left:6px;background:var(--rbac-fill);border-radius:999px;padding:1px 6px}
.rbac-col-head{font-size:10.5px;font-weight:500;color:var(--rbac-muted);text-align:center;white-space:nowrap}
.rbac-rows{display:flex;flex-direction:column}
.rbac-row{display:grid;grid-template-columns:minmax(0,1fr) 58px 58px 58px;align-items:center;padding:5px 12px;border-top:1px solid rgba(17,17,17,.05);min-height:40px}
.rbac-row:first-child{border-top:0}
.rbac-row:hover{background:#fcfcfb}
.rbac-row.is-child{padding-left:26px}
.rbac-entity{font-size:12.5px;color:var(--rbac-ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:10px}
.rbac-entity small{display:inline;font-size:10px;color:var(--rbac-muted);margin-left:6px;letter-spacing:.01em}
.rbac-action-cell{display:flex;align-items:center;justify-content:center;position:relative;min-height:30px}
.rbac-lock{appearance:none;width:30px;height:29px;border-radius:8px;border:1px solid transparent;background:var(--rbac-fill);color:var(--rbac-muted);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0;cursor:pointer;position:relative;transition:background .14s,color .14s,border-color .14s,transform .14s}
.rbac-lock:hover:not(:disabled){border-color:var(--rbac-line2);transform:translateY(-1px)}
.rbac-lock.is-on{background:var(--rbac-ink);color:#fff}
.rbac-lock.is-on:hover:not(:disabled){background:#000}
.rbac-lock:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(22,22,26,.18)}
.rbac-lock:disabled{opacity:.35;cursor:not-allowed;transform:none}
.rbac-lock .rbac-dot{width:3.5px;height:3.5px;border-radius:50%;background:currentColor;opacity:0;margin-top:1px}
.rbac-lock.is-override .rbac-dot{opacity:.9}
.rbac-lock.is-pending svg{opacity:.25}
.rbac-lock.is-pending::after{content:"";position:absolute;inset:8px;border:1.5px solid currentColor;border-top-color:transparent;border-radius:50%;animation:rbac-spin .7s linear infinite}
@keyframes rbac-spin{to{transform:rotate(360deg)}}
.rbac-none{color:var(--rbac-muted);font-size:12px;text-align:center;width:58px;user-select:none}
.rbac-cell-reset{position:absolute;right:1px;top:1px;width:16px;height:16px;border-radius:50%;border:1px solid var(--rbac-line);background:#fff;color:var(--rbac-muted);display:none;align-items:center;justify-content:center;font-size:10px;line-height:1;cursor:pointer;padding:0}
.rbac-action-cell:hover .rbac-cell-reset{display:flex}
.rbac-cell-reset:hover{color:var(--rbac-ink);border-color:var(--rbac-line2)}
.rbac-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--rbac-muted);font-size:12.5px;padding:56px 16px;text-align:center;flex:1}
.rbac-empty strong{color:var(--rbac-ink2);font-weight:500}
.rbac-error{border:1px solid rgba(217,45,32,.18);background:#fff7f6;color:#8f2318;border-radius:8px;padding:10px 12px;font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0}
.rbac-error button{appearance:none;border:1px solid rgba(217,45,32,.25);background:#fff;color:#8f2318;border-radius:6px;padding:3px 8px;font-size:11.5px;cursor:pointer}
.rbac-loading{display:flex;flex-direction:column;gap:8px;padding:12px 0}
.rbac-skel{height:38px;border-radius:8px;background:linear-gradient(90deg,#f5f4f2 25%,#faf9f8 37%,#f5f4f2 63%);background-size:400% 100%;animation:rbac-shimmer 1.3s ease infinite}
@keyframes rbac-shimmer{0%{background-position:100% 0}100%{background-position:0 0}}
.rbac-toast{position:absolute;right:18px;bottom:18px;z-index:20;background:#16161a;color:#fff;border-radius:8px;padding:8px 12px;font-size:12px;box-shadow:0 10px 30px rgba(31,35,41,.18);max-width:340px}
.rbac-toast.is-error{background:#8f2318}
.rbac-mobile-select{display:none;width:100%;height:32px;border:1px solid var(--rbac-line);border-radius:8px;background:#fff;font-size:12.5px;padding:0 8px;margin-bottom:10px}
@media(max-width:900px){
 .rbac-body{flex-direction:column}
 .rbac-people{width:auto;flex:0 0 auto;border-right:0;border-bottom:1px solid var(--rbac-line);padding:0 0 10px;margin-bottom:12px}
 .rbac-people-list{flex-direction:row;overflow-x:auto;overflow-y:hidden;padding-bottom:4px}
 .rbac-person{min-width:190px}
 .rbac-people-foot{display:none}
 .rbac-detail{padding-left:0}
 .rbac-mobile-select{display:block}
}
`;

function icon(name: 'search' | 'lock-open' | 'lock-closed' | 'chevron' | 'reset'): string {
  switch (name) {
    case 'search':
      return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>';
    case 'lock-open':
      return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 7.6-1.7"/><circle cx="12" cy="15.5" r="1.1" fill="currentColor" stroke="none"/></svg>';
    case 'lock-closed':
      return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.1" fill="currentColor" stroke="none"/></svg>';
    case 'chevron':
      return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    case 'reset':
      return '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch] ?? ch));
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function subjectRole(subject: RbacSubject): string {
  return subject.role || subject.roles?.[0] || 'user';
}

function subjectRoleLabel(role: string): string {
  switch (role) {
    case 'tenant_owner': return '拥有者';
    case 'tenant_admin': return '管理员';
    case 'enterprise_admin': return '管理员';
    case 'center_director': return '中心主任';
    case 'end_user': case 'user': return '成员';
    case 'team_admin': return '团队管理员';
    case 'data_admin': return '数据管理员';
    case 'analyst': return '分析师';
    case 'viewer': return '只读';
    case 'project_lead': return '项目负责人';
    case 'member': return '成员';
    default: return role;
  }
}

function groupKey(entity: RbacEntity): string {
  if (entity.type === 'feature') return 'feature';
  if (entity.type === 'table' && entity.parent_id) return `table:${entity.parent_id}`;
  return `type:${entity.type}`;
}

function groupLabel(key: string, entities: RbacEntity[], catalogEntities: RbacEntity[]): string {
  if (key === 'feature') return '功能权限';
  if (key.startsWith('table:')) {
    const parent = key.slice('table:'.length);
    const parentEntity = catalogEntities.find((item) => item.id === parent && item.type !== 'table');
    const label = parentEntity?.label ?? parent;
    return `${label} · 数据表`;
  }
  const type = key.slice('type:'.length);
  return TYPE_LABEL[type] ?? type;
}

export function mountRbacPanel(host: HTMLElement, initial: RbacMountOptions): RbacPanelHandle {
  injectStyle();
  host.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'rbac';
  host.appendChild(root);

  const state: State = {
    options: initial,
    catalog: null,
    subjects: [],
    selectedId: null,
    matrix: null,
    matrices: new Map(),
    loadingCatalog: true,
    loadingMatrix: false,
    error: null,
    detailError: null,
    groupOpen: new Map(),
    search: '',
    pending: new Set(),
    toast: null,
    toastTimer: null,
  };

  let disposed = false;
  let toastEl: HTMLElement | null = null;

  function cellKey(type: string, id: string, action: string): string {
    return `${type}\u0000${id}\u0000${action}`;
  }

  function gateFor(type: string, id: string, action: RbacActionKey): boolean {
    const gate = state.matrix?.gates?.find(
      (item) => item.type === type && (item.id === undefined || item.id === id) && item.action === action,
    );
    return gate ? gate.allow : true;
  }

  function cellMap(): Map<string, RbacCell> {
    const map = new Map<string, RbacCell>();
    for (const cell of state.matrix?.cells ?? []) {
      map.set(cellKey(cell.type, cell.id, cell.action), cell);
    }
    return map;
  }

  function notify(message: string, error = false): void {
    state.toast = message;
    if (state.toastTimer !== null) window.clearTimeout(state.toastTimer);
    if (toastEl) toastEl.remove();
    toastEl = document.createElement('div');
    toastEl.className = `rbac-toast${error ? ' is-error' : ''}`;
    toastEl.textContent = message;
    root.appendChild(toastEl);
    state.toastTimer = window.setTimeout(() => {
      toastEl?.remove();
      toastEl = null;
      state.toast = null;
    }, 3200);
  }

  function renderTabs(): HTMLElement | null {
    if (!state.options.showSystemTabs) return null;
    const systems = state.options.systems ?? [];
    if (systems.length === 0) return null;
    const nav = document.createElement('nav');
    nav.className = 'rbac-tabs';
    nav.setAttribute('aria-label', '权限系统');
    for (const system of systems) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rbac-tab';
      button.disabled = system.state !== 'ready';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(system.code === state.options.system));
      if (system.state !== 'ready') {
        button.title = system.state === 'unconfigured' ? '该系统未接入'
          : system.state === 'unlinked' ? '当前企业空间尚未关联该系统'
          : system.reason || '连接失败';
      }
      const dot = document.createElement('span');
      dot.className = 'rbac-tab-dot';
      button.appendChild(dot);
      button.appendChild(document.createTextNode(system.label));
      button.addEventListener('click', () => {
        if (system.code === state.options.system) return;
        state.options.system = system.code;
        state.options.onSystemChange?.(system.code);
        render();
      });
      nav.appendChild(button);
    }
    return nav;
  }

  function renderPerson(subject: RbacSubject): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rbac-person';
    button.setAttribute('aria-current', String(subject.id === state.selectedId));
    const avatar = document.createElement('span');
    avatar.className = 'rbac-avatar';
    avatar.textContent = (subject.name || subject.username || '?').slice(0, 1).toUpperCase();

    const main = document.createElement('span');
    main.className = 'rbac-person-main';
    const name = document.createElement('span');
    name.className = 'rbac-person-name';
    name.textContent = subject.name || subject.username;
    const meta = document.createElement('span');
    meta.className = 'rbac-person-meta';
    meta.textContent = subject.username;
    main.append(name, meta);

    const side = document.createElement('span');
    side.className = 'rbac-person-side';
    const role = document.createElement('span');
    role.className = 'rbac-role';
    role.textContent = subjectRoleLabel(subjectRole(subject));
    const status = document.createElement('span');
    status.className = `rbac-status${subject.status === 'active' ? '' : ' is-off'}`;
    status.title = subject.status === 'active' ? '正常' : '已停用';
    side.append(role, status);
    if (subject.managed === false) {
      const local = document.createElement('span');
      local.className = 'rbac-local';
      local.textContent = '仅本系统';
      side.appendChild(local);
    }

    button.append(avatar, main, side);
    button.addEventListener('click', () => void selectSubject(subject.id));
    return button;
  }

  function renderPeople(): HTMLElement {
    const aside = document.createElement('aside');
    aside.className = 'rbac-people';
    const searchWrap = document.createElement('div');
    searchWrap.className = 'rbac-search';
    const searchIcon = document.createElement('span');
    searchIcon.innerHTML = icon('search');
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = '搜索成员';
    input.value = state.search;
    input.addEventListener('input', () => {
      state.search = input.value;
      renderPeopleList();
    });
    searchWrap.append(searchIcon, input);

    const list = document.createElement('div');
    list.className = 'rbac-people-list';
    const foot = document.createElement('div');
    foot.className = 'rbac-people-foot';

    const renderPeopleList = () => {
      list.innerHTML = '';
      const keyword = state.search.trim().toLowerCase();
      const filtered = state.subjects.filter((subject) => {
        if (!keyword) return true;
        return [subject.name, subject.username, subjectRole(subject)].some(
          (value) => (value ?? '').toLowerCase().includes(keyword),
        );
      });
      for (const subject of filtered) list.appendChild(renderPerson(subject));
      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'rbac-empty';
        empty.style.padding = '28px 8px';
        empty.textContent = state.subjects.length === 0
          ? (state.options.emptyPeopleText ?? '该系统中还没有成员')
          : '没有匹配的成员';
        list.appendChild(empty);
      }
      foot.textContent = `共 ${state.subjects.length} 人${state.search ? `，匹配 ${filtered.length} 人` : ''}`;
    };

    aside.append(searchWrap, list, foot);
    renderPeopleList();
    return aside;
  }

  function lockButton(entity: RbacEntity, action: RbacActionKey, cell: RbacCell | undefined): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'rbac-action-cell';
    if (!entity.actions.includes(action)) {
      const none = document.createElement('span');
      none.className = 'rbac-none';
      none.textContent = '—';
      wrap.appendChild(none);
      return wrap;
    }
    const gate = gateFor(entity.type, entity.id, action);
    const allow = cell?.allow ?? false;
    const source = cell?.source ?? 'role';
    const overridden = source === 'allow' || source === 'deny';
    const pending = state.pending.has(cellKey(entity.type, entity.id, action));

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `rbac-lock${allow ? ' is-on' : ''}${overridden ? ' is-override' : ''}${pending ? ' is-pending' : ''}`;
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', String(allow));
    const actionLabel = ACTION_FALLBACK.find((item) => item.key === action)?.label ?? action;
    const subjectName = state.matrix?.subject.name || state.matrix?.subject.username || '成员';
    button.setAttribute('aria-label', `${subjectName} · ${entity.label} · ${actionLabel}权限`);
    button.setAttribute('title', !gate
      ? '该成员的角色不具备此功能，资源授权不会生效'
      : allow
        ? `${actionLabel}：允许${overridden ? '（个人设置）' : '（角色默认）'}，点击关闭`
        : `${actionLabel}：拒绝${overridden ? '（个人设置）' : '（角色默认）'}，点击打开`);
    button.disabled = Boolean(state.options.readOnly) || !gate || pending || !state.matrix;
    button.innerHTML = `${allow ? icon('lock-open') : icon('lock-closed')}<i class="rbac-dot"></i>`;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (button.disabled) return;
      void toggle(entity, action, cell);
    });
    wrap.appendChild(button);

    if (overridden) {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'rbac-cell-reset';
      reset.title = '恢复角色默认';
      reset.setAttribute('aria-label', `${entity.label} · ${actionLabel} · 恢复角色默认`);
      reset.innerHTML = icon('reset');
      reset.addEventListener('click', (event) => {
        event.stopPropagation();
        if (state.options.readOnly) return;
        void setEffect(entity, action, null);
      });
      wrap.appendChild(reset);
    }
    return wrap;
  }

  function renderRow(entity: RbacEntity, cells: Map<string, RbacCell>, child = false): HTMLElement {
    const row = document.createElement('div');
    row.className = `rbac-row${child ? ' is-child' : ''}`;
    const name = document.createElement('div');
    name.className = 'rbac-entity';
    name.textContent = entity.label;
    name.title = entity.label;
    if (entity.type === 'feature') {
      const small = document.createElement('small');
      small.textContent = '功能';
      name.appendChild(small);
    }
    row.appendChild(name);
    for (const action of ACTION_FALLBACK) {
      row.appendChild(lockButton(entity, action.key, cells.get(cellKey(entity.type, entity.id, action.key))));
    }
    return row;
  }

  function renderGroup(key: string, entities: RbacEntity[]): HTMLElement {
    const section = document.createElement('section');
    section.className = 'rbac-group';
    const isTable = key.startsWith('table:');
    const open = state.groupOpen.get(key) ?? !isTable;
    section.dataset.open = String(open);

    const head = document.createElement('header');
    head.className = 'rbac-group-head';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'rbac-group-toggle';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.innerHTML = `${icon('chevron')}<span class="rbac-group-title">${escapeHtml(groupLabel(key, entities, state.catalog?.entities ?? []))}</span><span class="rbac-count">${entities.length}</span>`;
    toggle.addEventListener('click', () => {
      state.groupOpen.set(key, !open);
      render();
    });
    head.appendChild(toggle);
    for (const action of ACTION_FALLBACK) {
      const label = document.createElement('span');
      label.className = 'rbac-col-head';
      label.textContent = action.label;
      head.appendChild(label);
    }
    section.appendChild(head);

    if (open) {
      const rows = document.createElement('div');
      rows.className = 'rbac-rows';
      const cells = cellMap();
      for (const entity of entities) rows.appendChild(renderRow(entity, cells, isTable));
      section.appendChild(rows);
    }
    return section;
  }

  function renderDetail(): HTMLElement {
    const detail = document.createElement('section');
    detail.className = 'rbac-detail';

    if (state.loadingCatalog) {
      const loading = document.createElement('div');
      loading.className = 'rbac-loading';
      for (let i = 0; i < 8; i += 1) {
        const line = document.createElement('div');
        line.className = 'rbac-skel';
        loading.appendChild(line);
      }
      detail.appendChild(loading);
      return detail;
    }
    if (state.error) {
      detail.appendChild(errorBox(state.error, () => void load()));
      return detail;
    }
    if (state.subjects.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rbac-empty';
      empty.innerHTML = `<strong>${escapeHtml(state.options.emptyPeopleText ?? '该系统中还没有成员')}</strong><span>先在成员管理中邀请成员，或等下一次账号同步。</span>`;
      detail.appendChild(empty);
      return detail;
    }

    const subject = state.matrix?.subject
      ?? state.subjects.find((item) => item.id === state.selectedId)
      ?? null;
    if (!subject) {
      const empty = document.createElement('div');
      empty.className = 'rbac-empty';
      empty.textContent = '请选择左侧成员';
      detail.appendChild(empty);
      return detail;
    }

    const head = document.createElement('header');
    head.className = 'rbac-detail-head';
    const title = document.createElement('div');
    title.className = 'rbac-detail-title';
    title.innerHTML = `<div><h3>${escapeHtml(subject.name || subject.username)}</h3><p class="rbac-detail-sub">${escapeHtml(subject.username)} · ${escapeHtml(subjectRoleLabel(subjectRole(subject)))}${subject.managed === false ? ' · 仅本系统账号' : ''}</p></div>`;
    head.appendChild(title);
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'rbac-reset-all';
    reset.textContent = '全部恢复默认';
    reset.disabled = Boolean(state.options.readOnly) || !state.matrix;
    reset.addEventListener('click', () => void resetAll());
    head.appendChild(reset);
    detail.appendChild(head);

    const legend = document.createElement('div');
    legend.className = 'rbac-legend';
    legend.innerHTML = `<b><span class="rbac-mini-lock on">${icon('lock-open')}</span>允许</b><b><span class="rbac-mini-lock">${icon('lock-closed')}</span>拒绝</b><b><span class="rbac-mini-dot"></span>个人设置（无点=角色默认）</b><span>${escapeHtml(state.matrix?.baseline_label ?? '角色默认')}</span>`;
    detail.appendChild(legend);

    if (state.detailError) detail.appendChild(errorBox(state.detailError, () => void loadMatrix(state.selectedId ?? '', true)));
    if (state.loadingMatrix) {
      const loading = document.createElement('div');
      loading.className = 'rbac-loading';
      for (let i = 0; i < 6; i += 1) {
        const line = document.createElement('div');
        line.className = 'rbac-skel';
        loading.appendChild(line);
      }
      detail.appendChild(loading);
      return detail;
    }

    const groups = document.createElement('div');
    groups.className = 'rbac-groups';
    const entities = state.catalog?.entities ?? [];
    const grouped = new Map<string, RbacEntity[]>();
    for (const entity of entities) {
      const key = groupKey(entity);
      const list = grouped.get(key);
      if (list) list.push(entity); else grouped.set(key, [entity]);
    }
    // 功能 → 知识库/项目/数据源 → 每个数据源的表
    const order = (key: string): [number, string] =>
      key === 'feature' ? [0, ''] : key.startsWith('table:') ? [2, key] : [1, key];
    const keys = [...grouped.keys()].sort((a, b) => {
      const [oa, sa] = order(a); const [ob, sb] = order(b);
      return oa - ob || sa.localeCompare(sb);
    });
    for (const key of keys) groups.appendChild(renderGroup(key, grouped.get(key) ?? []));
    detail.appendChild(groups);
    return detail;
  }

  function errorBox(message: string, retry: () => void): HTMLElement {
    const box = document.createElement('div');
    box.className = 'rbac-error';
    const text = document.createElement('span');
    text.textContent = message;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '重试';
    button.addEventListener('click', retry);
    box.append(text, button);
    return box;
  }

  function render(): void {
    if (disposed) return;
    const prevGroups = root.querySelector<HTMLElement>('.rbac-groups');
    const prevPeople = root.querySelector<HTMLElement>('.rbac-people-list');
    const groupsTop = prevGroups?.scrollTop ?? 0;
    const peopleTop = prevPeople?.scrollTop ?? 0;
    root.innerHTML = '';
    const tabs = renderTabs();
    if (tabs) root.appendChild(tabs);
    if (state.options.showSystemTabs && state.options.systems) {
      const current = state.options.systems.find((item) => item.code === state.options.system);
      if (current && current.state !== 'ready') {
        const empty = document.createElement('div');
        empty.className = 'rbac-empty';
        empty.style.minHeight = '320px';
        empty.innerHTML = `<strong>${escapeHtml(current.label)}</strong><span>${escapeHtml(
          current.reason || (current.state === 'unconfigured' ? '该系统未接入权限聚合。' : current.state === 'unlinked' ? '当前企业空间还没有关联该系统，请先在平台管理里完成租户关联。' : '连接失败，请稍后重试。'),
        )}</span>`;
        root.appendChild(empty);
        return;
      }
    }
    const body = document.createElement('div');
    body.className = 'rbac-body';
    body.appendChild(renderPeople());
    body.appendChild(renderDetail());
    root.appendChild(body);
    const groups = root.querySelector<HTMLElement>('.rbac-groups');
    if (groups && groupsTop > 0) groups.scrollTop = groupsTop;
    const people = root.querySelector<HTMLElement>('.rbac-people-list');
    if (people && peopleTop > 0) people.scrollTop = peopleTop;
  }

  async function loadMatrix(subjectId: string, force = false): Promise<void> {
    if (!force) {
      const cached = state.matrices.get(subjectId);
      if (cached) {
        state.matrix = cached;
        state.detailError = null;
        render();
        return;
      }
    }
    state.loadingMatrix = true;
    state.detailError = null;
    render();
    try {
      const matrix = await state.options.adapter.loadMatrix(subjectId);
      if (disposed) return;
      state.matrix = matrix;
      state.matrices.set(subjectId, matrix);
    } catch (error) {
      state.detailError = error instanceof Error ? error.message : '权限矩阵加载失败';
    } finally {
      state.loadingMatrix = false;
      render();
    }
  }

  async function selectSubject(subjectId: string): Promise<void> {
    if (state.selectedId === subjectId) return;
    state.selectedId = subjectId;
    state.matrix = null;
    state.loadingMatrix = true;
    state.detailError = null;
    render();
    await loadMatrix(subjectId);
  }

  async function setEffect(entity: RbacEntity, action: RbacActionKey, effect: RbacEffect | null): Promise<void> {
    const subject = state.matrix?.subject;
    if (!subject) return;
    const key = cellKey(entity.type, entity.id, action);
    if (state.pending.has(key)) return;
    state.pending.add(key);
    render();
    try {
      const result = await state.options.adapter.setCell({
        subject_id: subject.id, type: entity.type, id: entity.id, action, effect,
      });
      if (disposed) return;
      // 功能/数据源变更会影响后代或闸门，整表重载；其余只更新一格。
      const needsReload = entity.type === 'feature' || entity.type === 'datasource';
      if (needsReload) {
        state.matrices.delete(subject.id);
        await loadMatrix(subject.id, true);
      } else if (state.matrix) {
        const existing = state.matrix.cells.find(
          (cell) => cell.type === entity.type && cell.id === entity.id && cell.action === action,
        );
        if (existing) {
          existing.allow = result.cell.allow;
          existing.source = result.cell.source;
        } else {
          state.matrix.cells.push(result.cell);
        }
        state.matrices.set(subject.id, state.matrix);
        render();
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '保存失败，已恢复', true);
    } finally {
      state.pending.delete(key);
      if (!disposed) render();
    }
  }

  async function toggle(entity: RbacEntity, action: RbacActionKey, cell: RbacCell | undefined): Promise<void> {
    const allow = cell?.allow ?? false;
    const source = cell?.source ?? 'role';
    let effect: RbacEffect | null;
    if (allow) effect = 'deny';
    else if (source === 'deny' || source === 'allow') effect = null;
    else effect = 'allow';
    await setEffect(entity, action, effect);
  }

  async function resetAll(): Promise<void> {
    const subject = state.matrix?.subject;
    if (!subject) return;
    if (!window.confirm(`把 ${subject.name || subject.username} 在本系统中的全部个人设置恢复为角色默认？`)) return;
    try {
      const result = await state.options.adapter.resetAll(subject.id);
      state.matrices.delete(subject.id);
      await loadMatrix(subject.id, true);
      notify(`已恢复 ${result.removed} 项个人设置`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '恢复默认失败', true);
    }
  }

  async function load(): Promise<void> {
    state.loadingCatalog = true;
    state.error = null;
    render();
    try {
      const [catalog, subjects] = await Promise.all([
        state.options.adapter.loadCatalog(),
        state.options.adapter.loadSubjects(),
      ]);
      if (disposed) return;
      state.catalog = catalog;
      state.subjects = Array.isArray(subjects) ? subjects : subjects.items;
      const selected = state.selectedId && state.subjects.some((item) => item.id === state.selectedId)
        ? state.selectedId
        : state.subjects[0]?.id ?? null;
      state.selectedId = selected;
      state.loadingCatalog = false;
      render();
      if (selected) await loadMatrix(selected);
    } catch (error) {
      if (disposed) return;
      state.loadingCatalog = false;
      state.error = error instanceof Error ? error.message : '权限数据加载失败';
      render();
    }
  }

  render();
  void load();

  return {
    destroy() {
      disposed = true;
      if (state.toastTimer !== null) window.clearTimeout(state.toastTimer);
      host.innerHTML = '';
    },
    update(options: Partial<RbacMountOptions>) {
      state.options = { ...state.options, ...options };
      if (options.adapter) {
        state.matrices.clear();
        void load();
      } else {
        render();
      }
    },
    reload() {
      state.matrices.clear();
      void load();
    },
  };
}
