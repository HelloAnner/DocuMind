// 统一 RBAC 的纯计算层：不碰数据库，前后端可从同一份规则理解权限。
// 资源实体：kb（DocuMind）。功能实体：kb/document/member/config/model/
// api_client/audit。动作固定 view/edit/manage。

export const RBAC_ACTIONS = [
  { key: 'view', label: '查看' },
  { key: 'edit', label: '编辑' },
  { key: 'manage', label: '管理' },
] as const;

export type RbacAction = (typeof RBAC_ACTIONS)[number]['key'];
export type RbacEffect = 'allow' | 'deny';
export type RbacSource = 'role' | 'allow' | 'deny';

export interface FeatureSpec {
  id: string;
  label: string;
  /** action -> 需要的原生权限点；空数组表示该动作不支持。 */
  actions: Partial<Record<RbacAction, string[]>>;
}

export interface RbacOverride {
  entity_type: string;
  entity_id: string;
  action: RbacAction;
  effect: RbacEffect;
}

export interface RbacCell {
  type: string;
  id: string;
  action: RbacAction;
  allow: boolean;
  source: RbacSource;
}

export interface RbacGate {
  type: string;
  /** 功能闸门按实体区分；资源闸门不填 id，作用于该类型全部实体。 */
  id?: string;
  action: RbacAction;
  allow: boolean;
}

export interface RbacEntity {
  type: string;
  id: string;
  label: string;
  actions: RbacAction[];
  parent_id?: string;
}

export interface RbacSubject {
  id: string;
  portal_user_id: string | null;
  username: string;
  name: string;
  role: string;
  roles: string[];
  status: string;
  managed: boolean;
}

export interface RbacMatrix {
  subject: RbacSubject;
  baseline_label: string;
  cells: RbacCell[];
  gates: RbacGate[];
}

export interface KbLike {
  id: string;
  name: string;
  status: string;
}

export const DOCUMIND_FEATURES: FeatureSpec[] = [
  {
    id: 'kb',
    label: '知识库管理',
    actions: { view: ['kb.read'], edit: ['kb.create'], manage: ['kb.manage'] },
  },
  {
    id: 'document',
    label: '文档处理',
    actions: { edit: ['document.upload'], manage: ['document.delete', 'document.reprocess'] },
  },
  {
    id: 'member',
    label: '成员管理',
    actions: { view: ['member.read'], manage: ['member.write', 'member.delete'] },
  },
  {
    id: 'config',
    label: '系统配置',
    actions: { view: ['config.read'], manage: ['config.write'] },
  },
  {
    id: 'model',
    label: '模型配置',
    actions: { manage: ['model.write', 'model.delete'] },
  },
  {
    id: 'api_client',
    label: 'API 客户端',
    actions: { view: ['api_client.read'], manage: ['api_client.write', 'api_client.revoke'] },
  },
  {
    id: 'audit',
    label: '审计日志',
    actions: { view: ['audit.read'] },
  },
];

const FEATURE_BY_ID = new Map(DOCUMIND_FEATURES.map((feature) => [feature.id, feature]));

export function featureById(id: string): FeatureSpec | undefined {
  return FEATURE_BY_ID.get(id);
}

export function featureActions(feature: FeatureSpec): RbacAction[] {
  return RBAC_ACTIONS.map((action) => action.key).filter(
    (action) => (feature.actions[action]?.length ?? 0) > 0,
  );
}

/** 功能动作需要的原生权限点；功能本身没有这个动作时返回空。 */
export function nativePoints(featureId: string, action: string): string[] {
  const feature = FEATURE_BY_ID.get(featureId);
  if (!feature) return [];
  return feature.actions[action as RbacAction] ?? [];
}

export function hasAll(permissions: ReadonlySet<string>, points: string[]): boolean {
  return points.length > 0 && points.every((point) => permissions.has(point));
}

/** 功能 deny 覆盖会移除对应动作的全部原生权限点（拒绝优先于角色基线）。 */
export function deniedNativePoints(overrides: RbacOverride[]): Set<string> {
  const denied = new Set<string>();
  for (const override of overrides) {
    if (override.entity_type !== 'feature' || override.effect !== 'deny') continue;
    for (const point of nativePoints(override.entity_id, override.action)) denied.add(point);
  }
  return denied;
}

export function overrideMap(overrides: RbacOverride[]): Map<string, RbacEffect> {
  const map = new Map<string, RbacEffect>();
  for (const override of overrides) {
    map.set(`${override.entity_type}\u0000${override.entity_id}\u0000${override.action}`, override.effect);
  }
  return map;
}

/**
 * KB 的有效动作。
 * - baselineVisible：管理员看全部；普通成员有任意 ACL（role/user）就可见。
 * - 原生动作闸门：kb.read / kb.write / kb.manage（已扣掉功能 deny）。
 * - 个人 allow 不能绕过功能闸门；个人 deny 永远优先。
 */
export function kbActions(params: {
  kbs: KbLike[];
  permissions: ReadonlySet<string>;
  admin: boolean;
  aclKbIds: ReadonlySet<string>;
  overrides: RbacOverride[];
}): Map<string, Set<RbacAction>> {
  const denied = deniedNativePoints(params.overrides);
  const effective = new Set([...params.permissions].filter((point) => !denied.has(point)));
  const gates: Record<RbacAction, boolean> = {
    view: effective.has('kb.read'),
    edit: effective.has('kb.write'),
    manage: effective.has('kb.manage'),
  };
  const overrides = overrideMap(params.overrides);
  const result = new Map<string, Set<RbacAction>>();
  for (const kb of params.kbs) {
    const baselineVisible = params.admin || params.aclKbIds.has(kb.id);
    const actions = new Set<RbacAction>();
    for (const action of RBAC_ACTIONS) {
      if (!gates[action.key]) continue;
      const own = overrides.get(`kb\u0000${kb.id}\u0000${action.key}`);
      if (own === 'deny') continue;
      if (own === 'allow' || baselineVisible) actions.add(action.key);
    }
    result.set(kb.id, actions);
  }
  return result;
}

export function featureGates(permissions: ReadonlySet<string>): RbacGate[] {
  const gates: RbacGate[] = [];
  for (const feature of DOCUMIND_FEATURES) {
    for (const action of featureActions(feature)) {
      const points = feature.actions[action] ?? [];
      gates.push({ type: 'feature', id: feature.id, action, allow: hasAll(permissions, points) });
    }
  }
  return gates;
}

export function kbGates(permissions: ReadonlySet<string>, overrides: RbacOverride[]): RbacGate[] {
  const denied = deniedNativePoints(overrides);
  const effective = new Set([...permissions].filter((point) => !denied.has(point)));
  return [
    { type: 'kb', action: 'view', allow: effective.has('kb.read') },
    { type: 'kb', action: 'edit', allow: effective.has('kb.write') },
    { type: 'kb', action: 'manage', allow: effective.has('kb.manage') },
  ];
}

export function buildFeatureCells(
  permissions: ReadonlySet<string>,
  overrides: RbacOverride[],
): RbacCell[] {
  const map = overrideMap(overrides);
  const cells: RbacCell[] = [];
  for (const feature of DOCUMIND_FEATURES) {
    for (const action of featureActions(feature)) {
      const points = feature.actions[action] ?? [];
      const baseline = hasAll(permissions, points);
      const own = map.get(`feature\u0000${feature.id}\u0000${action}`);
      if (own === 'deny') {
        cells.push({ type: 'feature', id: feature.id, action, allow: false, source: 'deny' });
      } else if (own === 'allow' || baseline) {
        cells.push({ type: 'feature', id: feature.id, action, allow: true, source: own === 'allow' ? 'allow' : 'role' });
      }
    }
  }
  return cells;
}

export function buildKbCells(params: {
  kbs: KbLike[];
  permissions: ReadonlySet<string>;
  admin: boolean;
  aclKbIds: ReadonlySet<string>;
  overrides: RbacOverride[];
}): RbacCell[] {
  const denied = deniedNativePoints(params.overrides);
  const effective = new Set([...params.permissions].filter((point) => !denied.has(point)));
  const gates: Record<RbacAction, boolean> = {
    view: effective.has('kb.read'),
    edit: effective.has('kb.write'),
    manage: effective.has('kb.manage'),
  };
  const map = overrideMap(params.overrides);
  const cells: RbacCell[] = [];
  for (const kb of params.kbs) {
    const baselineVisible = params.admin || params.aclKbIds.has(kb.id);
    for (const action of RBAC_ACTIONS) {
      const own = map.get(`kb\u0000${kb.id}\u0000${action.key}`);
      if (own === 'deny') {
        cells.push({ type: 'kb', id: kb.id, action: action.key, allow: false, source: 'deny' });
        continue;
      }
      const allow = gates[action.key] && (own === 'allow' || baselineVisible);
      if (allow || own === 'allow') {
        cells.push({
          type: 'kb', id: kb.id, action: action.key, allow,
          source: own === 'allow' ? 'allow' : 'role',
        });
      }
    }
  }
  return cells;
}

export function buildCatalog(kbs: KbLike[]): {
  system: string;
  actions: { key: RbacAction; label: string }[];
  entities: RbacEntity[];
} {
  return {
    system: 'documind',
    actions: RBAC_ACTIONS.map((action) => ({ key: action.key, label: action.label })),
    entities: [
      ...DOCUMIND_FEATURES.map((feature) => ({
        type: 'feature', id: feature.id, label: feature.label, actions: featureActions(feature),
      })),
      ...kbs.map((kb) => ({
        type: 'kb', id: kb.id, label: kb.name, actions: RBAC_ACTIONS.map((action) => action.key),
      })),
    ],
  };
}

/** 判断某条覆盖是否是合法实体/动作；返回错误码给路由层转 422。 */
export function validateTarget(
  type: string,
  id: string,
  action: string,
  kbs: ReadonlySet<string>,
): string | null {
  if (type === 'feature') {
    const feature = FEATURE_BY_ID.get(id);
    if (!feature) return 'unknown_entity';
    if (!feature.actions[action as RbacAction]?.length) return 'action_not_supported';
    return null;
  }
  if (type === 'kb') {
    if (!kbs.has(id)) return 'unknown_entity';
    if (!RBAC_ACTIONS.some((item) => item.key === action)) return 'action_not_supported';
    return null;
  }
  return 'unknown_entity_type';
}

export function matrixCell(
  type: string, id: string, action: RbacAction,
  allow: boolean, source: RbacSource,
): RbacCell {
  return { type, id, action, allow, source };
}
