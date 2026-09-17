// 移植自 apps/api-rs/src/api/admin_members.rs #[cfg(test)]
import { describe, expect, test } from 'bun:test';
import { normalizeMemberRole, normalizeMemberStatus } from './admin_members.ts';

describe('admin_members', () => {
  test('normalizes legacy member roles', () => {
    expect(normalizeMemberRole('tenant_admin')).toBe('tenant_admin');
    expect(normalizeMemberRole('user')).toBe('end_user');
    expect(() => normalizeMemberRole('super_admin')).toThrow();
  });

  test('validates member status', () => {
    expect(normalizeMemberStatus('suspended')).toBe('suspended');
    expect(() => normalizeMemberStatus('removed')).toThrow();
  });
});
