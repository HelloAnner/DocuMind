// 移植自 apps/api-rs/src/api/system_tenants.rs #[cfg(test)]
import { describe, expect, test } from 'bun:test';
import { ensureStatusTransition, normalizeSlug } from './system_tenants.ts';

describe('system_tenants', () => {
  test('normalizes tenant slug', () => {
    expect(normalizeSlug(' Northwind Research ')).toBe('northwind-research');
    expect(() => normalizeSlug('中')).toThrow();
  });

  test('protects terminal deletion state', () => {
    expect(() => ensureStatusTransition('active', 'suspended')).not.toThrow();
    expect(() => ensureStatusTransition('deletion_pending', 'active')).toThrow();
  });
});
