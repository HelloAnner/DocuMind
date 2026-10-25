// Portal 租户/账号同步内部接口（DocuMind）。
// 只接受 X-Portal-Internal-Token；不参与本地 JWT / Portal SSO 鉴权。
import type { Context } from 'hono';
import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Sql } from 'postgres';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import type { AppState } from '../state.ts';

const PREFIX = '/api/portal/sync/v1';

function requireToken(c: Context<AppEnv>): AppState {
  const state = c.get('appState');
  const expected = process.env.PORTAL_INTERNAL_TOKEN ?? '';
  const provided = c.req.header('X-Portal-Internal-Token') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
    throw AppError.notFound('NOT_FOUND', 'Not found');
  }
  return state;
}

function requiredSql(state: AppState): Sql {
  if (!state.sql) throw AppError.internal('数据库不可用');
  return state.sql;
}

function text(value: unknown, label: string, max = 128): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw AppError.badRequest('INVALID_FIELD', `无效字段 ${label}`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string, max = 128): string | null {
  if (value === undefined || value === null || value === '') return null;
  return text(value, label, max);
}

function canonicalRole(value: unknown): 'tenant_owner' | 'tenant_admin' | 'user' {
  if (value === 'tenant_owner' || value === 'tenant_admin') return value;
  return 'user';
}

function canonicalRoles(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  const out = new Set<string>();
  for (const role of list) {
    if (role === 'tenant_owner' || role === 'tenant_admin' || role === 'user') out.add(role);
  }
  return out.size ? [...out] : ['user'];
}

function reverseRole(roles: unknown): string {
  const list = Array.isArray(roles) ? roles.map(String) : [];
  if (list.includes('tenant_owner')) return 'tenant_owner';
  if (list.includes('tenant_admin') || list.includes('enterprise_admin')) return 'tenant_admin';
  return 'user';
}

function memberStatus(value: unknown): 'active' | 'suspended' | 'removed' {
  if (value === 'suspended' || value === 'removed') return value;
  return 'active';
}

function tenantStatus(value: unknown): string {
  if (value === 'pending' || value === 'suspended' || value === 'archived' || value === 'deletion_pending') return value;
  return 'active';
}

const uuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function errorResponse(c: Context<AppEnv>, error: unknown) {
  if (error instanceof AppError) return c.json({ error: error.code, message: error.message }, error.httpStatus as 400);
  const message = error instanceof Error ? error.message : String(error);
  console.error('portal_sync_failed', message);
  return c.json({ error: 'internal_error', message }, 500);
}

async function uniqueEmail(sql: Sql, username: string, email: string | null): Promise<string> {
  const candidate = (email ?? '').trim().toLowerCase();
  if (candidate && candidate.length <= 128) {
    const existing = await sql`SELECT 1 FROM app_user WHERE lower(email)=lower(${candidate}) LIMIT 1`;
    if (!existing.length) return candidate;
  }
  const base = `${username}@portal.local`.slice(0, 128);
  const existing = await sql`SELECT 1 FROM app_user WHERE lower(email)=lower(${base}) LIMIT 1`;
  if (!existing.length) return base;
  return `${username.slice(0, 100)}+${crypto.randomUUID().slice(0, 8)}@portal.local`;
}

async function revokeUserSessions(state: AppState, userId: string): Promise<number> {
  const redis = state.redis;
  if (!redis) return 0;
  let cursor = '0';
  let revoked = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'documind:auth:session:*', 'COUNT', 500);
    cursor = next;
    for (const key of keys) {
      try {
        const raw = await redis.get(key);
        if (!raw) continue;
        const session = JSON.parse(raw) as { user_id?: string };
        if (session.user_id === userId) {
          await redis.del(key);
          revoked++;
        }
      } catch {
        // ignore one bad session
      }
    }
  } while (cursor !== '0');
  return revoked;
  // ponytail: scan-based revocation; add a user->session index if session count grows.
}

export function portalSyncRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get(`${PREFIX}/health`, (c) => {
    requireToken(c);
    return c.json({ ok: true, system_code: 'documind', db: 'ok', server_time: new Date().toISOString() });
  });

  router.get(`${PREFIX}/capabilities`, (c) => {
    requireToken(c);
    return c.json({
      version: 1,
      system_code: 'documind',
      features: ['tenants.list', 'tenants.upsert', 'members.list', 'members.upsert', 'members.link', 'sessions.revoke'],
      limits: { page_size: 500, max_body_bytes: 1048576 },
      server_time: new Date().toISOString(),
    });
  });

  router.get(`${PREFIX}/tenants`, async (c) => {
    try {
      const state = requireToken(c);
      const sql = requiredSql(state);
      const rows = await sql`
        SELECT t.id,t.name,t.slug,t.status,t.created_at,t.updated_at,
          (SELECT COUNT(*) FROM tenant_member m WHERE m.tenant_id=t.id AND m.status='active')::int AS member_count
        FROM tenant t ORDER BY t.created_at
      `;
      return c.json({
        items: rows.map((row) => ({
          local_tenant_id: String(row.id),
          code: String(row.slug),
          name: String(row.name),
          status: String(row.status ?? 'active'),
          member_count: Number(row.member_count ?? 0),
          created_at: row.created_at,
          updated_at: row.updated_at,
        })),
        next_cursor: null,
        server_time: new Date().toISOString(),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  router.get(`${PREFIX}/tenants/:id/members`, async (c) => {
    try {
      const state = requireToken(c);
      const sql = requiredSql(state);
      const tenantId = c.req.param('id');
      const rows = await sql`
        SELECT u.id,u.login_id,u.email,u.name,m.roles,m.status,m.updated_at,i.portal_user_id
        FROM tenant_member m
        JOIN app_user u ON u.id=m.user_id
        LEFT JOIN portal_identity_mapping i
          ON i.local_user_id=u.id AND i.local_tenant_id=m.tenant_id
        WHERE m.tenant_id=${tenantId}
          AND NOT EXISTS (SELECT 1 FROM platform_admin pa WHERE pa.user_id=u.id AND pa.status='active')
        ORDER BY u.login_id
      `;
      return c.json({
        items: rows.map((row) => {
          const roles = Array.isArray(row.roles) ? row.roles.map(String) : [];
          const unmapped = roles.filter((role) => ![
            'tenant_owner', 'tenant_admin', 'enterprise_admin', 'user', 'analyst', 'end_user',
          ].includes(role));
          return {
            local_user_id: String(row.id),
            username: String(row.login_id),
            display_name: String(row.name ?? row.login_id),
            email: row.email ? String(row.email) : null,
            status: String(row.status ?? 'active'),
            roles: [reverseRole(roles)],
            ...(unmapped.length ? { role_unmapped: unmapped } : {}),
            portal_user_id: row.portal_user_id ? String(row.portal_user_id) : null,
            updated_at: row.updated_at,
          };
        }),
        next_cursor: null,
        server_time: new Date().toISOString(),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  router.post(`${PREFIX}/tenants`, async (c) => {
    try {
      const state = requireToken(c);
      const sql = requiredSql(state);
      const body = await c.req.json() as Record<string, unknown>;
      const portalTenantId = text(body.portal_tenant_id, 'portal_tenant_id', 64);
      const code = text(body.code, 'code', 64);
      const name = text(body.name, 'name', 128);
      const status = tenantStatus(body.status);

      const bySlug = await sql`SELECT id FROM tenant WHERE lower(slug)=lower(${code}) LIMIT 1`;
      let localId = bySlug[0]?.id ? String(bySlug[0].id) : '';

      const mappedByPortal = await sql`
        SELECT tenant_id FROM portal_tenant_mapping WHERE portal_tenant_id=${portalTenantId} LIMIT 1
      `;
      if (mappedByPortal[0]?.tenant_id && localId && String(mappedByPortal[0].tenant_id) !== localId) {
        throw AppError.conflictWith('TENANT_CODE_CONFLICT', '租户 code 已被其他本地租户占用');
      }
      if (localId) {
        const mappedByLocal = await sql`
          SELECT portal_tenant_id FROM portal_tenant_mapping WHERE tenant_id=${localId} LIMIT 1
        `;
        if (mappedByLocal[0]?.portal_tenant_id && String(mappedByLocal[0].portal_tenant_id) !== portalTenantId) {
          throw AppError.conflictWith('TENANT_CODE_CONFLICT', '本地租户已映射到其他 Portal 租户');
        }
      }

      let created = false;
      if (!localId) {
        localId = uuid(portalTenantId) ? portalTenantId : crypto.randomUUID();
        const conflict = await sql`SELECT id FROM tenant WHERE id=${localId} LIMIT 1`;
        if (conflict.length) localId = crypto.randomUUID();
        await sql`
          INSERT INTO tenant (id,name,slug,status,plan)
          VALUES (${localId},${name},${code},${status},'enterprise')
        `;
        created = true;
      } else {
        await sql`UPDATE tenant SET name=${name},status=${status},updated_at=NOW() WHERE id=${localId}`;
      }
      await sql`
        INSERT INTO portal_tenant_mapping (portal_tenant_id,portal_tenant_code,tenant_id,origin)
        VALUES (${portalTenantId},${code},${localId},'portal_created')
        ON CONFLICT (portal_tenant_id) DO UPDATE SET
          portal_tenant_code=excluded.portal_tenant_code, tenant_id=excluded.tenant_id
      `;
      return c.json({ local_tenant_id: localId, created, code, status });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  router.put(`${PREFIX}/tenants/:id/members/:portalUserId`, async (c) => {
    try {
      const state = requireToken(c);
      const sql = requiredSql(state);
      const localTenantId = c.req.param('id');
      const portalUserId = c.req.param('portalUserId');
      const body = await c.req.json() as Record<string, unknown>;
      const username = text(body.username, 'username', 128);
      const displayName = optionalText(body.display_name, 'display_name', 128) ?? username;
      const email = optionalText(body.email, 'email', 128);
      const role = canonicalRole(canonicalRoles(body.roles)[0]);
      const status = memberStatus(body.status);

      const tenant = await sql`SELECT id,name FROM tenant WHERE id=${localTenantId} LIMIT 1`;
      if (!tenant.length) throw AppError.notFound('TENANT_NOT_FOUND', '租户不存在');

      const mapping = await sql`
        SELECT portal_tenant_id FROM portal_tenant_mapping WHERE tenant_id=${localTenantId} LIMIT 1
      `;
      const portalTenantId = mapping[0]?.portal_tenant_id
        ? String(mapping[0].portal_tenant_id)
        : (uuid(localTenantId) ? localTenantId : '');
      if (!portalTenantId) throw AppError.conflictWith('PORTAL_TENANT_MAPPING_MISSING', '缺少 Portal 租户映射');

      const linked = await sql`
        SELECT local_user_id FROM portal_identity_mapping
        WHERE portal_user_id=${portalUserId} AND portal_tenant_id=${portalTenantId} LIMIT 1
      `;
      let localUserId = linked[0]?.local_user_id ? String(linked[0].local_user_id) : '';
      let created = false;
      let recovered = false;

      if (!localUserId) {
        const byLogin = await sql`
          SELECT u.id FROM app_user u
          JOIN tenant_member m ON m.user_id=u.id AND m.tenant_id=${localTenantId}
          WHERE lower(u.login_id)=lower(${username}) LIMIT 1
        `;
        if (byLogin[0]?.id) {
          localUserId = String(byLogin[0].id);
          recovered = true;
        } else {
          const global = await sql`
            SELECT u.id FROM app_user u
            JOIN platform_admin pa ON pa.user_id=u.id AND pa.status='active'
            WHERE lower(u.login_id)=lower(${username}) LIMIT 1
          `;
          if (global.length) throw AppError.conflictWith('SUPER_ADMIN_FORBIDDEN', '不能映射平台管理员');
          const anyUser = await sql`
            SELECT id FROM app_user WHERE lower(login_id)=lower(${username}) LIMIT 1
          `;
          if (anyUser[0]?.id) {
            localUserId = String(anyUser[0].id);
            recovered = true;
          } else {
            localUserId = crypto.randomUUID();
            const passwordHash = await bcrypt.hash(`portal:${portalUserId}:${crypto.randomUUID()}`, 10);
            const finalEmail = await uniqueEmail(sql, username, email);
            await sql`
              INSERT INTO app_user (id,login_id,email,name,password_hash,auth_provider,sso_subject,status)
              VALUES (${localUserId},${username},${finalEmail},${displayName},${passwordHash},'portal',${portalUserId},'active')
            `;
            created = true;
          }
        }
        await sql`
          INSERT INTO portal_identity_mapping
            (portal_user_id,portal_tenant_id,local_user_id,local_tenant_id)
          VALUES (${portalUserId},${portalTenantId},${localUserId},${localTenantId})
          ON CONFLICT (portal_user_id,portal_tenant_id) DO UPDATE SET
            local_user_id=excluded.local_user_id, local_tenant_id=excluded.local_tenant_id
        `;
      }

      await sql`
        INSERT INTO tenant_member (id,tenant_id,user_id,roles,status,joined_at,updated_at)
        VALUES (gen_random_uuid(),${localTenantId},${localUserId},ARRAY[${role}]::text[],${status},NOW(),NOW())
        ON CONFLICT (tenant_id,user_id) DO UPDATE SET
          roles=excluded.roles, status=excluded.status, updated_at=NOW()
      `;

      let revoked = 0;
      if (status !== 'active') revoked = await revokeUserSessions(state, localUserId);
      const finalUser = await sql`SELECT login_id FROM app_user WHERE id=${localUserId} LIMIT 1`;
      return c.json({
        local_user_id: localUserId,
        local_tenant_id: localTenantId,
        local_username: String(finalUser[0]?.login_id ?? username),
        created,
        linked: !created,
        status,
        roles: [role],
        sessions_revoked: revoked,
        ...(recovered ? { recovered_existing_user: true } : {}),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  router.post(`${PREFIX}/tenants/:id/members/:portalUserId/link`, async (c) => {
    try {
      const state = requireToken(c);
      const sql = requiredSql(state);
      const localTenantId = c.req.param('id');
      const portalUserId = c.req.param('portalUserId');
      const body = await c.req.json() as Record<string, unknown>;
      if (body.confirm !== true) throw AppError.badRequest('CONFIRM_REQUIRED', 'confirm=true 必填');
      text(body.reason, 'reason', 500);
      const localUserId = text(body.local_user_id, 'local_user_id', 64);

      const member = await sql`
        SELECT u.id,u.login_id FROM app_user u
        JOIN tenant_member m ON m.user_id=u.id AND m.tenant_id=${localTenantId}
        WHERE u.id=${localUserId} LIMIT 1
      `;
      if (!member.length) throw AppError.notFound('LOCAL_USER_NOT_FOUND', '本地用户不存在');
      const admin = await sql`
        SELECT 1 FROM platform_admin WHERE user_id=${localUserId} AND status='active' LIMIT 1
      `;
      if (admin.length) throw AppError.conflictWith('SUPER_ADMIN_FORBIDDEN', '不能映射平台管理员');

      const existing = await sql`
        SELECT portal_user_id FROM portal_identity_mapping
        WHERE local_user_id=${localUserId} AND local_tenant_id=${localTenantId} LIMIT 1
      `;
      if (existing[0]?.portal_user_id && String(existing[0].portal_user_id) !== portalUserId) {
        throw AppError.conflictWith('LOCAL_USER_ALREADY_LINKED', '本地用户已关联其他 Portal 账号');
      }
      const mapping = await sql`
        SELECT portal_tenant_id FROM portal_tenant_mapping WHERE tenant_id=${localTenantId} LIMIT 1
      `;
      const portalTenantId = mapping[0]?.portal_tenant_id
        ? String(mapping[0].portal_tenant_id)
        : (uuid(localTenantId) ? localTenantId : '');
      if (!portalTenantId) throw AppError.conflictWith('PORTAL_TENANT_MAPPING_MISSING', '缺少 Portal 租户映射');

      await sql`
        INSERT INTO portal_identity_mapping
          (portal_user_id,portal_tenant_id,local_user_id,local_tenant_id)
        VALUES (${portalUserId},${portalTenantId},${localUserId},${localTenantId})
        ON CONFLICT (portal_user_id,portal_tenant_id) DO UPDATE SET
          local_user_id=excluded.local_user_id, local_tenant_id=excluded.local_tenant_id
      `;
      return c.json({ linked: true, local_user_id: localUserId, local_username: String(member[0]?.login_id ?? '') });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return router;
}
