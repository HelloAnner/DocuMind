import { describe, expect, test } from 'bun:test';
import { parseEditableSystemSettings } from './system_settings.ts';

describe('system settings input', () => {
  test('accepts supported boundaries and rejects unsafe values', () => {
    expect(parseEditableSystemSettings({
      auth_token_expire_hours: 1,
      object_storage_presign_expire_seconds: 86_400,
    })).toEqual({
      auth_token_expire_hours: 1,
      object_storage_presign_expire_seconds: 86_400,
    });
    expect(() => parseEditableSystemSettings({
      auth_token_expire_hours: 0,
      object_storage_presign_expire_seconds: 900,
    })).toThrow();
    expect(() => parseEditableSystemSettings({
      auth_token_expire_hours: 24.5,
      object_storage_presign_expire_seconds: 59,
    })).toThrow();
  });
});
