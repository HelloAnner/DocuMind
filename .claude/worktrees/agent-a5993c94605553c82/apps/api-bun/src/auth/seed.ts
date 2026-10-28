// 移植自 apps/api-rs/src/auth.rs 的 seed_identity
import bcrypt from 'bcryptjs';
import type { Sql } from 'postgres';
import type { AppConfig } from '../config.ts';

async function upsertSeedUser(
  sql: Sql, id: string, email: string, name: string, password: string,
): Promise<void> {
  const passwordHash = await bcrypt.hash(password, 10);
  await sql`
    INSERT INTO app_user (id, login_id, email, name, password_hash, status)
    VALUES (${id}, ${email}, ${email}, ${name}, ${passwordHash}, 'active')
    ON CONFLICT (id)
    DO UPDATE SET login_id = EXCLUDED.login_id, email = EXCLUDED.email, name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, status = 'active', updated_at = NOW()
  `;
}

async function upsertMembership(
  sql: Sql, tenantId: string, userId: string, roles: string[],
): Promise<void> {
  await sql`
    INSERT INTO tenant_member (tenant_id, user_id, roles, status, joined_at)
    VALUES (${tenantId}, ${userId}, ${roles}, 'active', NOW())
    ON CONFLICT (tenant_id, user_id)
    DO UPDATE SET roles = EXCLUDED.roles, status = 'active', updated_at = NOW()
  `;
}

async function upsertAcl(
  sql: Sql, tenantId: string, kbId: string, role: string, permission: string,
): Promise<void> {
  await sql`
    INSERT INTO knowledge_base_acl (tenant_id, kb_id, subject_type, subject_id, permission)
    VALUES (${tenantId}, ${kbId}, 'role', ${role}, ${permission})
    ON CONFLICT (tenant_id, kb_id, subject_type, subject_id, permission) DO NOTHING
  `;
}

export async function seedIdentity(sql: Sql, config: AppConfig): Promise<void> {
  await sql`
    INSERT INTO tenant (id, name, slug, plan, status)
    VALUES (${config.defaultTenantId}, ${config.defaultTenantName}, ${config.defaultTenantSlug}, 'enterprise', 'active')
    ON CONFLICT (id)
    DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug, updated_at = NOW()
  `;

  await upsertSeedUser(sql, config.defaultUserId, config.enterpriseAdminEmail,
    'DocuMind Enterprise Admin', config.enterpriseAdminPassword);
  await upsertSeedUser(sql, config.superAdminUserId, config.superAdminEmail,
    'Anner', config.superAdminPassword);
  await sql`
    INSERT INTO platform_admin (user_id, role, status)
    VALUES (${config.superAdminUserId}, 'super_admin', 'active')
    ON CONFLICT (user_id)
    DO UPDATE SET role = 'super_admin', status = 'active', updated_at = NOW()
  `;
  await upsertSeedUser(sql, config.standardUserId, config.standardUserEmail,
    'DocuMind User', config.standardUserPassword);

  await upsertMembership(sql, config.defaultTenantId, config.defaultUserId, ['tenant_admin']);
  await sql`
    INSERT INTO tenant_member (tenant_id, user_id, roles, status, joined_at)
    VALUES (${config.defaultTenantId}, ${config.superAdminUserId}, ARRAY['super_admin'], 'active', NOW())
    ON CONFLICT (tenant_id, user_id) DO NOTHING
  `;
  await upsertMembership(sql, config.defaultTenantId, config.standardUserId, ['end_user']);

  const productKbId = config.defaultKbIds[0] ?? '00000000-0000-0000-0000-000000000010';
  await sql`
    INSERT INTO knowledge_base (id, tenant_id, name, description, status, tags)
    VALUES (${productKbId}, ${config.defaultTenantId}, '产品文档库', '面向全公司的产品手册与白皮书集合', 'active', ARRAY['产品'])
    ON CONFLICT (id)
    DO UPDATE SET tenant_id = EXCLUDED.tenant_id, name = EXCLUDED.name, status = EXCLUDED.status, updated_at = NOW()
  `;

  await upsertAcl(sql, config.defaultTenantId, productKbId, 'tenant_admin', 'manage');
  await upsertAcl(sql, config.defaultTenantId, productKbId, 'end_user', 'read');
}
