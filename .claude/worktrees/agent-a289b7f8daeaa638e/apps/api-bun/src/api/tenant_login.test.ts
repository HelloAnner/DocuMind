import { describe, expect, test } from 'bun:test';
import { normalizeTenantSlug, parseLoginBranding } from './tenant_login.ts';

describe('tenant_login', () => {
  test('normalizes public tenant slug', () => {
    expect(normalizeTenantSlug('  Acme-01 ')).toBe('acme-01');
    expect(() => normalizeTenantSlug('a')).toThrow();
    expect(() => normalizeTenantSlug('acme_01')).toThrow();
    expect(() => normalizeTenantSlug('租户')).toThrow();
  });
  test('exposes only supported login branding', () => {
    const branding = parseLoginBranding({
      login_kicker: '  可信知识，持续生长  ',
      login_headline: '让经验成为共同的判断依据',
      login_description: '连接团队文档与业务上下文。',
      login_welcome: '欢迎回到知识中枢',
      login_tone: 'jade',
      secret: 'must-not-leak',
    });
    expect(branding.kicker).toBe('可信知识，持续生长');
    expect(branding.tone).toBe('jade');
    expect('secret' in branding).toBe(false);
  });
  test('rejects unknown tone and empty copy', () => {
    const branding = parseLoginBranding({ login_kicker: ' ', login_tone: 'neon' });
    expect(branding.kicker ?? null).toBeNull();
    expect(branding.tone ?? null).toBeNull();
  });
});
