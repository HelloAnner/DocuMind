import { describe, expect, test } from 'bun:test';
import {
  buildFeatureCells,
  buildKbCells,
  deniedNativePoints,
  kbActions,
  kbGates,
  validateTarget,
  type RbacOverride,
} from './rbac_core.ts';

const ALL = new Set([
  'kb.read', 'kb.create', 'kb.write', 'kb.manage',
  'document.upload', 'document.delete', 'document.reprocess',
  'member.read', 'member.write', 'member.delete',
  'config.read', 'config.write', 'model.write', 'model.delete',
  'api_client.read', 'api_client.write', 'api_client.revoke', 'audit.read',
]);

const kbs = [
  { id: 'k1', name: '产品手册', status: 'active' },
  { id: 'k2', name: '合同库', status: 'active' },
];

function cellsOf(cells: ReturnType<typeof buildKbCells>, id: string) {
  return Object.fromEntries(cells.filter((cell) => cell.id === id).map((cell) => [cell.action, cell]));
}

describe('rbac_core', () => {
  test('管理员基线：全部功能与知识库动作开放', () => {
    const cells = buildFeatureCells(ALL, []);
    expect(cells.find((cell) => cell.id === 'kb' && cell.action === 'manage')?.allow).toBe(true);
    expect(cells.find((cell) => cell.id === 'audit' && cell.action === 'view')?.allow).toBe(true);
    const kbCells = buildKbCells({ kbs, permissions: ALL, admin: true, aclKbIds: new Set(), overrides: [] });
    expect(kbCells.filter((cell) => cell.id === 'k1').map((cell) => cell.action)).toEqual(['view', 'edit', 'manage']);
  });

  test('个人 deny 覆盖角色基线，allow 覆盖默认拒绝', () => {
    const overrides: RbacOverride[] = [
      { entity_type: 'kb', entity_id: 'k1', action: 'view', effect: 'deny' },
      { entity_type: 'kb', entity_id: 'k2', action: 'view', effect: 'allow' },
    ];
    const k1 = cellsOf(buildKbCells({
      kbs, permissions: ALL, admin: false, aclKbIds: new Set(['k1']), overrides,
    }), 'k1');
    expect(k1.view).toMatchObject({ allow: false, source: 'deny' });
    const k2 = cellsOf(buildKbCells({
      kbs, permissions: ALL, admin: false, aclKbIds: new Set(['k1']), overrides,
    }), 'k2');
    expect(k2.view).toMatchObject({ allow: true, source: 'allow' });
    // k2 没有基线，allow 只打开 view，不会顺带打开 edit/manage。
    expect(k2.edit).toBeUndefined();
    expect(k2.manage).toBeUndefined();
  });

  test('功能 deny 移除原生权限点并关闭资源闸门', () => {
    const overrides: RbacOverride[] = [
      { entity_type: 'feature', entity_id: 'kb', action: 'view', effect: 'deny' },
    ];
    expect(deniedNativePoints(overrides)).toEqual(new Set(['kb.read']));
    const gates = kbGates(ALL, overrides);
    expect(gates.find((gate) => gate.type === 'kb' && gate.action === 'view')?.allow).toBe(false);
    const actions = kbActions({
      kbs, permissions: ALL, admin: true, aclKbIds: new Set(), overrides,
    });
    expect(actions.get('k1')?.has('view')).toBe(false);
    // 只 deny 了 view，编辑与管理仍然可用。
    expect(actions.get('k1')?.has('edit')).toBe(true);
    expect(actions.get('k1')?.has('manage')).toBe(true);
  });

  test('个人 allow 不能绕过功能闸门', () => {
    const noWrite = new Set([...ALL].filter((point) => point !== 'kb.write'));
    const overrides: RbacOverride[] = [
      { entity_type: 'kb', entity_id: 'k1', action: 'edit', effect: 'allow' },
    ];
    const k1 = cellsOf(buildKbCells({
      kbs, permissions: noWrite, admin: false, aclKbIds: new Set(), overrides,
    }), 'k1');
    // 覆盖保留（source=allow），但有效值为 false，UI 会显示“已设置但角色无此功能”。
    expect(k1.edit).toMatchObject({ allow: false, source: 'allow' });
  });

  test('未知实体/动作被拒绝', () => {
    expect(validateTarget('kb', 'k1', 'view', new Set(['k1']))).toBeNull();
    expect(validateTarget('kb', 'missing', 'view', new Set(['k1']))).toBe('unknown_entity');
    expect(validateTarget('feature', 'document', 'view', new Set())).toBe('action_not_supported');
    expect(validateTarget('feature', 'nope', 'view', new Set())).toBe('unknown_entity');
    expect(validateTarget('table', 'x', 'view', new Set())).toBe('unknown_entity_type');
  });
});
