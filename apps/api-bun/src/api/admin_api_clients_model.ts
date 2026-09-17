// 移植自 apps/api-rs/src/api/admin_api_clients_model.rs
import { AppError } from '../errors.ts';
import { DEFAULT_SCOPES } from './external_api.ts';

export interface CreateClientRequest {
  name: string;
  description?: string | null;
  kb_ids: string[];
  scopes?: string[] | null;
  expires_in_days?: number | null;
  rate_limit_per_minute?: number | null;
}

export interface CreateTokenRequest { expires_in_days?: number | null; }

export interface UpdateClientRequest { status: string; }

export interface TokenSummary {
  id: string;
  token_prefix: string;
  status: string;
  expires_at: string;
  last_used_at: string | null;
  created_at: string;
}

export interface ClientSummary {
  id: string;
  name: string;
  description: string | null;
  scopes: string[];
  status: string;
  rate_limit_per_minute: number;
  kb_ids: string[];
  tokens: TokenSummary[];
  created_at: string;
}

export interface CreatedClient { client: ClientSummary; token: string; }
export interface CreatedToken { token: TokenSummary; secret: string; }

export function normalizeName(value: string): string {
  const name = (value ?? '').trim();
  if (name.length === 0 || [...name].length > 128) {
    throw AppError.badRequest('API_CLIENT_NAME_INVALID', '应用名称长度必须为 1 到 128 个字符');
  }
  return name;
}

export function normalizeScopes(scopes: string[]): string[] {
  const list = scopes.length === 0 ? [...DEFAULT_SCOPES] : [...scopes];
  if (list.some((scope) => !DEFAULT_SCOPES.includes(scope))) {
    throw AppError.badRequest('API_SCOPE_INVALID', '存在不支持的 API Scope');
  }
  return [...new Set(list)].sort();
}

export function validateExpiration(days: number): void {
  if (days >= 1 && days <= 365) return;
  throw AppError.badRequest('API_TOKEN_EXPIRATION_INVALID', 'Token 有效期必须为 1 到 365 天');
}

export function defaultExpiresInDays(): number { return 90; }
export function defaultRateLimit(): number { return 60; }
