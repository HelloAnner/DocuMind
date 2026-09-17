// 移植自 apps/api-rs/src/api/tenant_login.rs
import { Hono } from 'hono';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';

const MAX_TENANT_SLUG_LENGTH = 63;

interface TenantLoginBranding {
  kicker?: string | null; headline?: string | null; description?: string | null;
  welcome?: string | null; tone?: string | null;
}
interface TenantLoginContext { name: string; slug: string; branding: TenantLoginBranding; }

export function tenantLoginRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/auth/tenant-context', getTenantLoginContextHandler);
  router.get('/api/v1/auth/tenant-context', getTenantLoginContextHandler);
  return router;
}

async function getTenantLoginContextHandler(c: import('hono').Context<AppEnv>) {
  const state = c.get('appState');
  const tenant = c.req.query('tenant') ?? '';
  const slug = normalizeTenantSlug(tenant);
  const sql = state.sql;
  if (!sql) throw AppError.internal('tenant login context requires a database connection');
  const rows = await sql`
    SELECT name, slug, branding
    FROM tenant
    WHERE lower(slug) = lower(${slug})
      AND status = 'active'
  `;
  const row = rows[0];
  if (!row) throw tenantLoginNotFound();
  return c.json({
    name: String(row.name), slug: String(row.slug),
    branding: parseLoginBranding((row.branding ?? {}) as Record<string, unknown>),
  } satisfies TenantLoginContext);
}

export function normalizeTenantSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  const valid = slug.length >= 2 && slug.length <= MAX_TENANT_SLUG_LENGTH
    && [...slug].every((ch) => /[a-z0-9]/.test(ch) || ch === '-');
  if (!valid) throw tenantLoginNotFound();
  return slug;
}

function tenantLoginNotFound(): AppError {
  return AppError.notFound('TENANT_LOGIN_NOT_FOUND', '企业登录入口不存在或暂不可用');
}

export function parseLoginBranding(value: Record<string, unknown>): TenantLoginBranding {
  const branding: TenantLoginBranding = {};
  const kicker = brandingText(value, 'login_kicker', 32);
  if (kicker !== null) branding.kicker = kicker;
  const headline = brandingText(value, 'login_headline', 64);
  if (headline !== null) branding.headline = headline;
  const description = brandingText(value, 'login_description', 120);
  if (description !== null) branding.description = description;
  const welcome = brandingText(value, 'login_welcome', 40);
  if (welcome !== null) branding.welcome = welcome;
  const tone = brandingTone(value);
  if (tone !== null) branding.tone = tone;
  return branding;
}

function brandingText(value: Record<string, unknown>, key: string, maxChars: number): string | null {
  const raw = value[key];
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  return [...text].slice(0, maxChars).join('');
}

function brandingTone(value: Record<string, unknown>): string | null {
  const raw = value.login_tone;
  if (typeof raw !== 'string') return null;
  const tone = raw.trim();
  return ['violet', 'azure', 'jade', 'amber', 'rose'].includes(tone) ? tone : null;
}
