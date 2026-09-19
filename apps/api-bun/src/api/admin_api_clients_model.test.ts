// 移植自 apps/api-rs/src/api/admin_api_clients_model.rs #[cfg(test)]
import { describe, expect, test } from 'bun:test';
import { normalizeName, normalizeScopes, validateExpiration } from './admin_api_clients_model.ts';

describe('admin_api_clients_model', () => {
  test('validates scopes and expiration', () => {
    expect(normalizeScopes([])).toEqual([
      'chat:write',
      'conversations:read',
      'conversations:write',
      'knowledge_bases:read',
    ]);
    expect(() => normalizeScopes(['admin:write'])).toThrow();
    expect(() => validateExpiration(90)).not.toThrow();
    expect(() => validateExpiration(0)).toThrow();
  });

  test('normalizes client name', () => {
    expect(normalizeName('  DocuMind 应用 ')).toBe('DocuMind 应用');
    expect(() => normalizeName('   ')).toThrow();
  });
});
