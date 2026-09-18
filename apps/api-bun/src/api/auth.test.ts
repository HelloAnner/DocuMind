import { describe, expect, test } from 'bun:test';
import {
  intersectPermissions, mapDocumindRoles, mapPortalPermissions,
  normalizeInvitationAccount, slugify,
} from './auth.ts';
import { derivePermissions } from '../auth/permissions.ts';

describe('api/auth', () => {
  test('validates invitation account', () => {
    expect(normalizeInvitationAccount(' Admin@Example.com ')).toBe('admin@example.com');
    expect(normalizeInvitationAccount('Anner')).toBe('anner');
    expect(() => normalizeInvitationAccount('')).toThrow();
    expect(() => normalizeInvitationAccount('bad id')).toThrow();
  });
  test('platform administrators can manage tenant content', () => {
    expect(derivePermissions(['super_admin'])).toEqual(expect.arrayContaining([
      'kb.read', 'kb.create', 'kb.write', 'kb.manage',
      'document.upload', 'document.delete', 'document.reprocess',
      'chat.ask', 'answer.feedback',
    ]));
  });
  test('maps portal permissions to local names', () => {
    expect(mapPortalPermissions([
      'documind:chat:ask', 'documind:knowledge:manage', 'documind:document:upload', 'unknown',
    ])).toEqual(['chat.ask', 'document.upload', 'kb.manage']);
  });
  test('clamps local permissions to portal upper bound', () => {
    expect(intersectPermissions(
      ['chat.ask', 'document.upload', 'kb.manage'], ['chat.ask', 'kb.manage'],
    )).toEqual(['chat.ask', 'kb.manage']);
  });
  test('maps portal roles with priority order', () => {
    expect(mapDocumindRoles({
      user_id: 'u', username: 'u', display_name: 'u', tenant_id: 't',
      system_code: 'documind', expires_at: 0,
      system_roles: ['viewer'], portal_roles: ['tenant-admin'],
    })).toEqual(['tenant_admin', 'end_user']);
  });
  test('slugify keeps ascii words', () => {
    expect(slugify('Acme Corp_01')).toBe('acme-corp-01');
  });
});
