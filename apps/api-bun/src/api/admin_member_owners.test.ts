import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { adminMembersRouter } from './admin_members.ts';
import type { AppEnv } from '../http/types.ts';

// Memory-only transaction boundary: no service or database is started.
test('owner aliases participate in last-administrator protection and allow another admin to be demoted', async () => {
  for (const ownerTarget of [true, false]) {
    let counted = false, updated = false;
    const tx: any = async (parts: TemplateStringsArray) => {
      const query = parts.join('?');
      if (query.includes('SELECT id FROM tenant')) return [{ id: 'tenant' }];
      if (query.includes('SELECT roles, status')) return [{ roles: [ownerTarget ? 'tenant_owner' : 'tenant_admin'], status: 'active' }];
      if (query.includes('COUNT(*)')) {
        counted = true;
        expect(query).toContain("'tenant_owner'");
        return [{ count: ownerTarget ? 0 : 1 }];
      }
      if (query.includes('UPDATE tenant_member')) { updated = true; return [{ roles: ['end_user'], status: 'active' }]; }
      return [];
    };
    tx.json = (value: unknown) => value;
    tx.begin = (callback: (sql: any) => unknown) => callback(tx);
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('appState', { sql: tx } as any);
      c.set('actor', { tenant_id: 'tenant', user_id: 'actor', roles: ['tenant_admin'], permissions: ['member.write'] } as any);
      await next();
    });
    app.onError((error, c) => c.json({ error: error.message }, 409));
    app.route('/', adminMembersRouter());
    const response = await app.request('/api/admin/members/target', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'end_user' }) });
    expect(counted).toBe(true);
    expect(response.status, await response.text()).toBe(ownerTarget ? 409 : 200);
    expect(updated).toBe(!ownerTarget);
  }
});
