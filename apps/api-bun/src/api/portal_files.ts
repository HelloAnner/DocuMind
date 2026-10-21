import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../http/types.ts';
import { AppError } from '../errors.ts';
import { isUuid } from '../infra/uuid.ts';
import { getOwnedUserFile, listOwnedUserFiles, withObjectStorageTimeout } from '../files/service.ts';

async function mappedUser(c: Context<AppEnv>) {
  const expected = process.env.PORTAL_INTERNAL_TOKEN ?? '';
  const provided = c.req.header('X-Portal-Internal-Token') ?? '';
  const a = Buffer.from(expected), b = Buffer.from(provided);
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) throw AppError.unauthorized();
  const user = c.req.query('portal_user_id'), tenant = c.req.query('portal_tenant_id');
  if (!isUuid(user ?? '') || !isUuid(tenant ?? '')) throw AppError.badRequest('INVALID_IDENTITY', 'Portal identity required');
  const sql = c.get('appState').sql;
  if (!sql) throw AppError.notFound('NOT_FOUND', 'Not found');
  const links = await sql.unsafe(`SELECT i.local_user_id, i.local_tenant_id
    FROM portal_identity_mapping i JOIN portal_tenant_mapping t
      ON t.portal_tenant_id=i.portal_tenant_id AND t.tenant_id=i.local_tenant_id
    WHERE i.portal_user_id=$1 AND i.portal_tenant_id=$2`, [user!, tenant!]);
  if (!links[0]) return null;
  const id = String(links[0].local_user_id), tenantId = String(links[0].local_tenant_id);
  const active = await sql.unsafe(`SELECT 1 FROM tenant_member m
    JOIN app_user u ON u.id=m.user_id JOIN tenant t ON t.id=m.tenant_id
    WHERE m.user_id=$1 AND m.tenant_id=$2 AND m.status='active'
      AND u.status='active' AND t.status='active'`, [id, tenantId]);
  if (!active.length) throw AppError.notFound('NOT_FOUND', 'Not found');
  return { sql, id, tenantId };
}

export function portalFilesRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/portal/files', async c => {
    const user = await mappedUser(c);
    if (!user) return c.json({ code: 'portal_identity_unlinked' }, 409);
    const scope = c.req.query('scope') ?? 'personal';
    if (scope !== 'personal' && scope !== 'space') throw AppError.badRequest('INVALID_SCOPE', 'Invalid scope');
    const limit = Number(c.req.query('limit') ?? 50), offset = Number(c.req.query('cursor') ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw AppError.badRequest('INVALID_PAGE', 'Invalid pagination');
    const files = await listOwnedUserFiles(user.sql, user.tenantId, user.id, null, scope);
    return c.json({ files: files.slice(offset, offset + limit).map(f => ({ ...f, source_system: 'documind' })), next_cursor: offset + limit < files.length ? String(offset + limit) : null });
  });
  for (const action of ['content', 'preview']) router.get(`/api/portal/files/:id/${action}`, async c => {
    const user = await mappedUser(c);
    if (!user) return c.json({ code: 'portal_identity_unlinked' }, 409);
    const file = await getOwnedUserFile(user.sql, user.tenantId, user.id, c.req.param('id'));
    const bytes = await withObjectStorageTimeout('get', signal => c.get('appState').storage.get(file.storage_key, signal));
    await mappedUser(c);
    await getOwnedUserFile(user.sql, user.tenantId, user.id, file.id);
    return new Response(new Uint8Array(bytes), { headers: {
      'Content-Type': file.mime_type, 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'",
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    } });
  });
  return router;
}
