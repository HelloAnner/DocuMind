import type { Sql } from 'postgres';
import type { AppConfig } from './config.ts';
import { AppError } from './errors.ts';

export interface EditableSystemSettings {
  auth_token_expire_hours: number;
  object_storage_presign_expire_seconds: number;
}

const TOKEN_MIN = 1;
const TOKEN_MAX = 720;
const PRESIGN_MIN = 60;
const PRESIGN_MAX = 86_400;

export async function loadSystemSettings(sql: Sql, config: AppConfig): Promise<void> {
  const rows = await sql`SELECT key, value FROM system_setting`;
  for (const row of rows) {
    const value = row.value;
    if (row.key === 'auth_token_expire_hours' && validInteger(value, TOKEN_MIN, TOKEN_MAX)) {
      config.authTokenExpireHours = value;
    }
    if (row.key === 'object_storage_presign_expire_seconds'
      && validInteger(value, PRESIGN_MIN, PRESIGN_MAX)) {
      config.objectStoragePresignExpireSeconds = value;
    }
  }
}

export function editableSystemSettings(config: AppConfig): EditableSystemSettings {
  return {
    auth_token_expire_hours: config.authTokenExpireHours,
    object_storage_presign_expire_seconds: config.objectStoragePresignExpireSeconds,
  };
}

export async function saveSystemSettings(
  sql: Sql,
  config: AppConfig,
  actorUserId: string,
  input: unknown,
): Promise<EditableSystemSettings> {
  const parsed = parseEditableSystemSettings(input);
  const tokenHours = parsed.auth_token_expire_hours;
  const presignSeconds = parsed.object_storage_presign_expire_seconds;

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO system_setting (key, value, updated_by)
      VALUES ('auth_token_expire_hours', ${tx.json(tokenHours)}, ${actorUserId})
      ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    `;
    await tx`
      INSERT INTO system_setting (key, value, updated_by)
      VALUES ('object_storage_presign_expire_seconds', ${tx.json(presignSeconds)}, ${actorUserId})
      ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    `;
  });

  config.authTokenExpireHours = tokenHours;
  config.objectStoragePresignExpireSeconds = presignSeconds;
  return editableSystemSettings(config);
}

export function parseEditableSystemSettings(input: unknown): EditableSystemSettings {
  if (!input || typeof input !== 'object') {
    throw AppError.badRequest('SYSTEM_SETTINGS_INVALID', '系统设置格式无效');
  }
  const tokenHours = 'auth_token_expire_hours' in input
    ? input.auth_token_expire_hours : undefined;
  const presignSeconds = 'object_storage_presign_expire_seconds' in input
    ? input.object_storage_presign_expire_seconds : undefined;
  if (!validInteger(tokenHours, TOKEN_MIN, TOKEN_MAX)) {
    throw AppError.badRequest('SYSTEM_SETTINGS_INVALID', '会话有效期必须是 1 到 720 小时的整数');
  }
  if (!validInteger(presignSeconds, PRESIGN_MIN, PRESIGN_MAX)) {
    throw AppError.badRequest('SYSTEM_SETTINGS_INVALID', '预览链接有效期必须是 60 到 86400 秒的整数');
  }
  return {
    auth_token_expire_hours: tokenHours,
    object_storage_presign_expire_seconds: presignSeconds,
  };
}

export const systemSettingLimits = {
  auth_token_expire_hours: { min: TOKEN_MIN, max: TOKEN_MAX, unit: '小时' },
  object_storage_presign_expire_seconds: { min: PRESIGN_MIN, max: PRESIGN_MAX, unit: '秒' },
} as const;

function validInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
