import bcrypt from 'bcryptjs';
import { actorFromClaims } from '../auth/actor.ts';
import type { Claims } from '../auth/jwt.ts';
import { AppError } from '../errors.ts';
import { claimsFromAuthorizationHeader, issueToken } from '../auth/jwt.ts';
import { createAuthSession, validateAndRenewAuthSession } from '../auth/session.ts';
import type { CurrentActor } from '../models/identity.ts';
import type { Sql } from 'postgres';
import { Hono } from 'hono';
import type { AppEnv } from '../http/types.ts';
import type { AppState } from '../state.ts';
import { describe, expect, test } from 'bun:test';
import {
  intersectPermissions, mapDocumindRoles, mapPortalPermissions, portalMembershipRoles,
  normalizeInvitationAccount, slugify, authRouter, provisionPortalActor, resolvePortalTenant,
} from './auth.ts';
import { derivePermissions } from '../auth/permissions.ts';

import type Redis from 'ioredis';
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
  test('portal-wide roles cannot elevate DocuMind system roles', () => {
    expect(mapDocumindRoles({
      user_id: 'u', username: 'u', display_name: 'u', tenant_id: 't',
      system_code: 'documind', expires_at: 0,
      system_roles: ['user'], portal_roles: ['tenant-admin'],
    })).toEqual(['end_user']);
    expect(() => mapDocumindRoles({
      user_id: 'u', username: 'u', display_name: 'u', tenant_id: 't',
      system_code: 'documind', expires_at: 0,
      system_roles: [], portal_roles: ['super-admin'],
    })).toThrow();
    expect(() => mapDocumindRoles({
      user_id: 'u', username: 'u', display_name: 'u', tenant_id: 't',
      system_code: 'documind', expires_at: 0,
      system_roles: ['super_admin'], portal_roles: [],
    })).toThrow();
  });
  test('approved tenant mapping resolves a different local UUID and slug', async () => {
    const portal = {
      user_id: '11111111-1111-4111-8111-111111111111', username: 'u',
      display_name: 'u', tenant_id: '22222222-2222-4222-8222-222222222222',
      tenant_code: 'portal-acme', system_code: 'documind', expires_at: 0,
    };
    const sql = ((strings: TemplateStringsArray, ...params: unknown[]) => {
      expect(strings.join('?')).toContain('FROM portal_tenant_mapping');
      expect(params).toEqual([portal.tenant_id, portal.tenant_code]);
      return Promise.resolve([{ tenant_id: '33333333-3333-4333-8333-333333333333', status: 'active' }]);
    }) as unknown as Sql;
    expect(await resolvePortalTenant(sql, portal, false))
      .toBe('33333333-3333-4333-8333-333333333333');
    expect(portalMembershipRoles(['tenant_admin'], 'approved', ['end_user'])).toEqual(['end_user']);
    expect(portalMembershipRoles(['tenant_admin'], 'approved', ['tenant_admin'])).toEqual(['tenant_admin']);
    expect(portalMembershipRoles(['tenant_admin'], 'approved', ['tenant_owner'])).toEqual(['tenant_admin']);
    expect(portalMembershipRoles(['end_user'], 'approved', ['tenant_owner'])).toEqual(['end_user']);
    expect(portalMembershipRoles(['tenant_admin'], 'approved')).toEqual(['end_user']);
    expect(portalMembershipRoles(['tenant_admin'], 'portal_created')).toEqual(['tenant_admin']);
  });
  test('Portal-created membership follows user-to-admin promotion without widening approved members', async () => {
    expect(portalMembershipRoles(['tenant_admin'], 'portal_created', ['end_user'], true))
      .toEqual(['tenant_admin']);
    expect(portalMembershipRoles(['tenant_admin'], 'portal_created', ['end_user'], false))
      .toEqual(['end_user']);
    expect(portalMembershipRoles(['tenant_admin'], 'approved', ['end_user'], true))
      .toEqual(['end_user']);
  });
  test('one Portal user retains two distinct historical tenant accounts', async () => {
    const tenantA = '33333333-3333-4333-8333-333333333333';
    const tenantB = '55555555-5555-4555-8555-555555555555';
    const userA = '44444444-4444-4444-8444-444444444444';
    const userB = '66666666-6666-4666-8666-666666666666';
    const portalA = '22222222-2222-4222-8222-222222222222';
    const portalB = '77777777-7777-4777-8777-777777777777';
    const users: Record<string, string> = { [tenantA]: userA, [tenantB]: userB };
    const portals: Record<string, string> = { [portalA]: tenantA, [portalB]: tenantB };
    const sql = Object.assign((strings: TemplateStringsArray, ...args: unknown[]) => {
      const query = strings.join('?');
      if (query.includes('SELECT m.tenant_id')) return Promise.resolve([
        { tenant_id: portals[String(args[0])], status: 'active' },
      ]);
      if (query.includes('FROM portal_identity_mapping pim')) return Promise.resolve([
        { id: users[portals[String(args[1])]!], status: 'active' },
      ]);
      if (query.includes('SELECT local_user_id AS id FROM portal_identity_mapping')) return Promise.resolve([
        { id: users[portals[String(args[1])]!] },
      ]);
      if (query.includes('SELECT roles, attributes FROM tenant_member')) return Promise.resolve([
        { roles: ['tenant_owner'], attributes: {} },
      ]);
      if (query.includes('SELECT origin FROM portal_tenant_mapping')) return Promise.resolve([{ origin: 'approved' }]);
      if (query.includes('UPDATE app_user') || query.includes('INSERT INTO tenant_member')) return Promise.resolve([]);
      if (query.includes('SELECT id, login_id')) return Promise.resolve([{
        id: String(args[0]), login_id: `old-${String(args[0]).slice(0, 8)}`,
        email: null, name: 'Historical account', status: 'active',
      }]);
      if (query.includes('SELECT EXISTS')) return Promise.resolve([{ active: false }]);
      if (query.includes('SELECT tm.roles')) return Promise.resolve([{ roles: ['tenant_owner'], attributes: {} }]);
      if (query.includes('FROM knowledge_base')) return Promise.resolve([]);
      if (query.includes('INSERT INTO audit_log')) return Promise.resolve([]);
      if (query.includes('SELECT avatar_url')) return Promise.resolve([{ avatar_url: null }]);
      if (query.includes('SELECT id, name, slug, plan, status FROM tenant')) return Promise.resolve([{
        id: String(args[0]), name: 'Historical tenant', slug: 'history', plan: 'enterprise', status: 'active',
      }]);
      throw new Error(`unexpected identity query: ${query}`);
    }, { json: (value: unknown) => value,
      begin: async (run: (tx: Sql) => Promise<unknown>) => run(sql),
    }) as unknown as Sql;
    const state = { sql, redis: { set: async () => 'OK' }, config: {
      authLoginMode: 'local', portalAuthEnabled: true, jwtSecret: 'two-tenant-test-secret', authTokenExpireHours: 1,
      portalBaseUrl: 'http://portal.test', portalExchangeEndpoint: '/exchange',
    } as AppState['config'] } as unknown as AppState;
    const portal = {
      user_id: '11111111-1111-4111-8111-111111111111',
      username: 'same-portal-user', display_name: 'Same Portal User',
      tenant_id: portalA, tenant_code: 'a', system_code: 'documind',
      system_roles: ['tenant_admin'], permissions: ['documind:chat:ask'],
      expires_at: Math.floor(Date.now() / 1000) + 60,
    };
    const a = await provisionPortalActor(state, portal, mapDocumindRoles(portal));
    portal.tenant_id = portalB;
    portal.tenant_code = 'b';
    const b = await provisionPortalActor(state, portal, mapDocumindRoles(portal));
    expect([a.actor.user_id, b.actor.user_id]).toEqual([userA, userB]);
    expect([a.actor.tenant_id, b.actor.tenant_id]).toEqual([tenantA, tenantB]);
    expect(a.actor.permissions).toEqual(['chat.ask']);
    expect(b.actor.permissions).toEqual(['chat.ask']);
    const oldFetch = globalThis.fetch;
    let used = false;
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('appState', state); await next(); });
    app.route('/', authRouter());
    app.onError((error, c) => c.json({ error: error.message },
      error instanceof AppError ? error.httpStatus as 401 : 500));
    try {
      globalThis.fetch = (async () => {
        if (used) return new Response(null, { status: 401 });
        used = true;
        return Response.json(portal);
      }) as unknown as typeof fetch;
      const ticket = `${crypto.randomUUID()}:secret`;
      const request = () => app.request('http://localhost/api/auth/portal/ticket', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: ticket }),
      });
      const response = await request();
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const login = await response.json() as { access_token: string; user: { id: string }; tenant: { id: string } };
      expect(login.user.id).toBe(userB);
      expect(login.tenant.id).toBe(tenantB);
      expect((await claimsFromAuthorizationHeader(state.config, `Bearer ${login.access_token}`)).auth_source)
        .toBe('portal');
      expect((await request()).status).toBe(401);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
  test('Portal sessions expire at creation deadline without sliding renewal', async () => {
    const actor = {
      user_id: '11111111-1111-4111-8111-111111111111',
      tenant_id: '22222222-2222-4222-8222-222222222222',
      roles: ['tenant_admin'], scope: 'tenant',
    } as CurrentActor;
    const config = {
      authTokenExpireHours: 1, jwtSecret: 'nonrenewable-session-test', authLoginMode: 'portal',
    } as AppState['config'];
    let stored = '';
    let writes = 0;
    const redis = {
      set: async (_key: string, value: string) => { stored = value; writes++; return 'OK'; },
      get: async () => stored,
    } as unknown as Redis;
    const sid = await createAuthSession(redis, config, actor, 'portal');
    const claims = {
      sub: actor.user_id, tenant_id: actor.tenant_id, role: 'tenant_admin',
      scope: 'tenant', sid, exp: Math.floor(Date.now() / 1000) + 3600,
      auth_source: 'portal', portal_permissions: ['chat.ask'],
    } as Claims;
    await validateAndRenewAuthSession(redis, config, claims);
    expect(writes).toBe(1);
    stored = JSON.stringify({ ...JSON.parse(stored), created_at: Math.floor(Date.now() / 1000) - 3601 });
    await expect(validateAndRenewAuthSession(redis, config, claims)).rejects.toMatchObject({ httpStatus: 401 });
    expect(writes).toBe(1);
    stored = JSON.stringify({ ...JSON.parse(stored), created_at: Math.floor(Date.now() / 1000) });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('appState', { config, redis } as AppState);
      await next();
    });
    app.route('/', authRouter());
    app.onError((error, c) => c.json({ error: error.message },
      error instanceof AppError ? error.httpStatus as 401 : 500));
    const token = await issueToken(config, actor, sid, ['chat.ask']);
    const refreshed = await app.request('http://localhost/api/auth/refresh', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    });
    expect(refreshed.status).toBe(401);
    expect(writes).toBe(1);
  });
  test('persisted owner survives portal owner/admin and lower-privilege sessions', async () => {
    const localTenant = '33333333-3333-4333-8333-333333333333';
    const localUser = '44444444-4444-4444-8444-444444444444';
    let storedRoles = ['tenant_owner'];
    let attributes: Record<string, unknown> = {};
    let mappingOrigin = 'approved';
    const sql = Object.assign((strings: TemplateStringsArray, ...args: unknown[]) => {
      const query = strings.join('?');
      if (query.includes('SELECT m.tenant_id')) return Promise.resolve([
        { tenant_id: localTenant, status: 'active' },
      ]);
      if (query.includes('FROM portal_identity_mapping pim')) return Promise.resolve([
        { id: localUser, status: 'active' },
      ]);
      if (query.includes('SELECT roles, attributes FROM tenant_member')) {
        return Promise.resolve([{ roles: storedRoles, attributes }]);
      }
      if (query.includes('SELECT origin FROM portal_tenant_mapping')) return Promise.resolve([{ origin: mappingOrigin }]);
      if (query.includes('UPDATE app_user')) return Promise.resolve([]);
      if (query.includes('INSERT INTO tenant_member')) {
        if (query.includes('SET roles = CASE') && mappingOrigin === 'portal_created'
          && attributes.auth_provider === 'portal' && !storedRoles.includes('tenant_owner')) {
          storedRoles = args[2] as string[];
        }
        attributes = args[3] as Record<string, unknown>;
        return Promise.resolve([]);
      }
      if (query.includes('SELECT id, login_id')) return Promise.resolve([{
        id: localUser, login_id: 'owner', email: 'owner@example.test', name: 'Owner', status: 'active',
      }]);
      if (query.includes('SELECT EXISTS')) return Promise.resolve([{ active: false }]);
      if (query.includes('SELECT tm.roles')) return Promise.resolve([{ roles: storedRoles, attributes }]);
      if (query.includes('FROM knowledge_base') || query.includes('FROM knowledge_base_acl')) return Promise.resolve([]);
      throw new Error('unexpected identity query');
    }, { json: (value: unknown) => value,
      begin: async (run: (tx: Sql) => Promise<unknown>) => run(sql),
    }) as unknown as Sql;
    const state = { sql, config: {
      jwtSecret: 'owner-session-test-secret', authTokenExpireHours: 1,
    } as AppState['config'] } as AppState;
    const portal = {
      user_id: '11111111-1111-4111-8111-111111111111', username: 'portal-owner',
      display_name: 'Portal Owner', email: 'owner@example.test',
      tenant_id: '22222222-2222-4222-8222-222222222222', tenant_code: 'portal-acme',
      system_code: 'documind', system_roles: ['tenant_owner'], permissions: ['documind:chat:ask'],
      expires_at: Math.floor(Date.now() / 1000) + 60,
    };
    for (const role of ['tenant_owner', 'tenant_admin'] as const) {
      portal.system_roles = [role];
      const provisioned = await provisionPortalActor(state, portal, mapDocumindRoles(portal));
      expect(storedRoles).toEqual(['tenant_owner']);
      expect(provisioned.actor.tenant_id).toBe(localTenant);
      expect(provisioned.actor.roles).toEqual(['tenant_admin']);
      expect(provisioned.actor.permissions).toEqual(['chat.ask']);
      const token = await issueToken(state.config, provisioned.actor, 'portal-session',
        provisioned.effective_permissions);
      const roundTrip = await claimsFromAuthorizationHeader(state.config, `Bearer ${token}`);
      expect(roundTrip.auth_source).toBe('portal');
      expect((await actorFromClaims({ sql, config: state.config }, roundTrip)).permissions).toEqual(['chat.ask']);
    }
    portal.system_roles = ['user'];
    const user = await provisionPortalActor(state, portal, mapDocumindRoles(portal));
    expect(storedRoles).toEqual(['tenant_owner']);
    expect(user.actor.roles).toEqual(['end_user']);
    expect(user.actor.permissions).toEqual(['chat.ask']);
    const userToken = await issueToken(state.config, user.actor, 'portal-session', user.effective_permissions);
    const userClaims = await claimsFromAuthorizationHeader(state.config, `Bearer ${userToken}`);
    expect((await actorFromClaims({ sql, config: state.config }, userClaims)).roles).toEqual(['end_user']);
    const local: Claims = {
      sub: localUser, tenant_id: localTenant, email: portal.email, role: 'tenant_admin',
      scope: 'tenant', sid: null, exp: Math.floor(Date.now() / 1000) + 60,
      auth_source: 'local',
    };
    const localActor = await actorFromClaims({ sql, config: state.config }, local);
    expect(localActor.roles).toEqual(['tenant_admin']);
    expect(localActor.permissions).toContain('tenant.write');
    const localToken = await issueToken(state.config, localActor, 'local-session');
    const localClaims = await claimsFromAuthorizationHeader(state.config, `Bearer ${localToken}`);
    expect((await actorFromClaims({ sql, config: state.config }, localClaims)).permissions).toContain('tenant.write');
    mappingOrigin = 'portal_created';
    storedRoles = ['end_user'];
    attributes = { auth_provider: 'portal' };
    portal.system_roles = ['tenant_admin'];
    const promoted = await provisionPortalActor(state, portal, mapDocumindRoles(portal));
    expect(storedRoles).toEqual(['tenant_admin']);
    expect(promoted.actor.roles).toEqual(['tenant_admin']);
    portal.system_roles = ['user'];
    const demoted = await provisionPortalActor(state, portal, mapDocumindRoles(portal));
    expect(storedRoles).toEqual(['end_user']);
    expect(demoted.actor.roles).toEqual(['end_user']);
  });
  test('no-conflict callback rejects an unapproved slug collision before provisioning', async () => {
    const oldFetch = globalThis.fetch;
    const portal = {
      user_id: '11111111-1111-4111-8111-111111111111',
      username: 'new-portal-user', display_name: 'New Portal User',
      tenant_id: '22222222-2222-4222-8222-222222222222',
      tenant_code: 'acme', system_code: 'documind', system_roles: ['tenant_admin'],
      permissions: ['documind:knowledge:manage'],
      expires_at: Math.floor(Date.now() / 1000) + 45,
    };
    const queries: string[] = [];
    const sql = Object.assign((strings: TemplateStringsArray) => {
      const query = strings.join('?');
      queries.push(query);
      if (query.includes('FROM portal_tenant_mapping')) return Promise.resolve([]);
      if (query.includes('FROM tenant WHERE')) return Promise.resolve([
        { id: '33333333-3333-4333-8333-333333333333' },
      ]);
      if (query.includes('INSERT INTO audit_log')) return Promise.resolve([]);
      throw new Error('callback must not provision into an unapproved local tenant');
    }, { json: (value: unknown) => JSON.stringify(value) });
    const state = { sql, redis: {}, config: {
      authLoginMode: 'portal', portalBaseUrl: 'http://127.0.0.1:6688',
      portalExchangeEndpoint: '/api/auth/exchange-ticket',
    } } as unknown as AppState;
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('appState', state); await next(); });
    app.route('/', authRouter());
    try {
      globalThis.fetch = (async () => Response.json(portal)) as unknown as typeof fetch;
      const response = await app.request(
        `http://localhost/auth/portal/callback?code=${crypto.randomUUID()}:secret`);
      expect(response.status).toBe(403);
      expect(queries.filter((query) => !query.includes('INSERT INTO audit_log'))).toHaveLength(2);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
  test('verified local owner can approve mapping; audit failure rolls back', async () => {
    const actor = {
      user_id: '33333333-3333-4333-8333-333333333333',
      tenant_id: '44444444-4444-4444-8444-444444444444',
      email: 'owner@local.test', scope: 'tenant', roles: ['tenant_owner'],
      permissions: ['tenant.write'], is_super_admin: false,
    } as CurrentActor;
    const config = {
      authLoginMode: 'portal', jwtSecret: 'local-test-secret', authTokenExpireHours: 1,
    } as AppState['config'];
    const token = await issueToken(config, actor, 'session-id');
    const hash = await bcrypt.hash('correct-password', 4);
    let approved = 0;
    let failAudit = false;
    const sql = Object.assign((strings: TemplateStringsArray) => {
      if (strings.join('?').includes('SELECT password_hash')) return Promise.resolve([
        { password_hash: hash, auth_provider: 'password' },
      ]);
      throw new Error('writes must use the transaction');
    }, {
      begin: async (run: (tx: Sql) => Promise<unknown>) => {
        let pending = 0;
        const tx = Object.assign((strings: TemplateStringsArray) => {
          const query = strings.join('?');
          if (query.includes('INSERT INTO portal_tenant_mapping')) {
            pending++;
            return Promise.resolve([{ tenant_id: actor.tenant_id }]);
          }
          if (query.includes('INSERT INTO audit_log')) {
            if (failAudit) throw new Error('audit storage unavailable');
            return Promise.resolve([]);
          }
          throw new Error('unexpected transaction query');
        }, { json: (value: unknown) => JSON.stringify(value) });
        await run(tx as unknown as Sql);
        approved += pending;
      },
    });
    const redis = { get: async () => JSON.stringify({
      user_id: actor.user_id, tenant_id: actor.tenant_id,
      role: actor.roles[0], scope: 'tenant', created_at: 0, last_seen_at: 0,
    }), set: async () => 'OK' };
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('actor', actor);
      c.set('appState', { config, sql, redis } as unknown as AppState);
      await next();
    });
    app.route('/', authRouter());
    app.onError((error, c) => c.json({ error: error.message },
      error instanceof AppError ? error.httpStatus as 403 : 500));
    const request = (password: string) => app.request('http://localhost/api/auth/portal/tenant-mapping', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        portal_tenant_id: '22222222-2222-4222-8222-222222222222',
        portal_tenant_code: 'portal-acme', password,
      }),
    });
    expect((await request('wrong-password')).status).toBe(401);
    expect(approved).toBe(0);
    failAudit = true;
    expect((await request('correct-password')).status).toBe(500);
    expect(approved).toBe(0);
    failAudit = false;
    const result = await request('correct-password');
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      portal_tenant_id: '22222222-2222-4222-8222-222222222222',
      tenant_id: actor.tenant_id,
    });
    expect(approved).toBe(1);
  });
  test('existing email requires a verified local-session linkage, never automatic takeover', async () => {
    const oldFetch = globalThis.fetch;
    const localTenant = '33333333-3333-4333-8333-333333333333';
    const localUser = localTenant;
    const portal = {
      user_id: '11111111-1111-4111-8111-111111111111',
      username: 'portal-user', display_name: 'Portal User', email: 'local@example.com',
      tenant_id: '22222222-2222-4222-8222-222222222222',
      tenant_code: 'acme', system_code: 'documind',
      system_roles: ['user'], permissions: ['documind:chat:ask'],
      expires_at: Math.floor(Date.now() / 1000) + 45,
    };
    const queries: string[] = [];
    let linked = false;
    let memberAttributes: Record<string, unknown> = {};
    let failLinkAudit = true;
    const audits: Array<{ tenantId: unknown; actorId: unknown; action: unknown; resourceId: unknown; detail: unknown }> = [];
    let candidates = [
      { id: '44444444-4444-4444-8444-444444444444', sso_subject: portal.user_id },
      { id: localUser, sso_subject: null as string | null },
    ];
    const sql = Object.assign((strings: TemplateStringsArray, ...args: unknown[]) => {
      const query = strings.join('?');
      queries.push(query);
      if (query.includes('SELECT m.tenant_id')) return Promise.resolve([
        { tenant_id: localTenant, status: 'active' },
      ]);
      if (query.includes('SELECT origin FROM portal_tenant_mapping')) return Promise.resolve([{ origin: 'approved' }]);
      if (query.includes('FROM portal_identity_mapping pim')) return Promise.resolve(linked
        ? [{ id: localUser, status: 'active' }] : []);
      if (query.includes('SELECT local_user_id AS id FROM portal_identity_mapping')) return Promise.resolve([]);
      if (query.includes('INSERT INTO portal_identity_mapping')) {
        linked = true;
        return Promise.resolve([{ local_user_id: localUser }]);
      }
      if (query.includes('SELECT t.id FROM tenant_member')) return Promise.resolve([{ id: localTenant }]);
      if (query.includes('SELECT roles, attributes FROM tenant_member')) return Promise.resolve([
        { roles: ['tenant_admin'], attributes: memberAttributes },
      ]);
      if (query.includes('INSERT INTO tenant_member')) {
        memberAttributes = args[3] as Record<string, unknown>;
        return Promise.resolve([]);
      }
      if (query.includes('INSERT INTO audit_log')) {
        if (failLinkAudit) throw new Error('forced link audit failure');
        audits.push({ tenantId: args[0], actorId: args[1], action: args[3],
          resourceId: args[5], detail: args[6] });
        return Promise.resolve([]);
      }
      if (query.includes('UPDATE app_user')) return Promise.resolve([]);
      if (query.includes('SELECT id, login_id')) return Promise.resolve([{
        id: String(args[0]), login_id: 'old-b', email: null, name: 'Old B', status: 'active',
      }]);
      if (query.includes('SELECT EXISTS')) return Promise.resolve([{ active: false }]);
      if (query.includes('SELECT tm.roles')) return Promise.resolve([
        { roles: ['tenant_admin'], attributes: memberAttributes },
      ]);
      if (query.includes('FROM knowledge_base')) return Promise.resolve([]);
      if (query.includes('SELECT u.id, u.sso_subject')) return Promise.resolve(candidates);
      throw new Error('callback must not provision an unverified local identity');
    }, { json: (value: unknown) => value,
      begin: async (run: (tx: Sql) => Promise<unknown>) => {
        const wasLinked = linked;
        const priorAttributes = memberAttributes;
        const priorAudits = audits.length;
        try { return await run(sql); }
        catch (error) {
          linked = wasLinked;
          memberAttributes = priorAttributes;
          audits.length = priorAudits;
          throw error;
        }
      },
    }) as unknown as Sql;
    let challenge: string | undefined;
    let pending = '';
    let portalSessions = 0;
    const redis = {
      set: async (key: string, value: string) => {
        if (key.startsWith('documind:portal:link:')) {
          challenge = key;
          pending = value;
          expect(JSON.parse(value).user_ids).toEqual(candidates.map((row) => row.id));
        }
        if (key.startsWith('documind:auth:session:')
          && (JSON.parse(value) as { auth_source?: string }).auth_source === 'portal') portalSessions++;
        return 'OK';
      },
      get: async (key: string) => key.startsWith('documind:portal:link:') ? pending
        : JSON.stringify({ user_id: localUser, tenant_id: localTenant, role: 'tenant_admin',
          scope: 'tenant', created_at: Math.floor(Date.now() / 1000), last_seen_at: 0 }),
      del: async () => { pending = ''; return 1; },
    };
    const state = { sql, redis, config: {
      authLoginMode: 'portal', portalBaseUrl: 'http://127.0.0.1:6688',
      portalExchangeEndpoint: '/api/auth/exchange-ticket',
      jwtSecret: 'link-test-secret', authTokenExpireHours: 1,
    } } as unknown as AppState;
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('appState', state);
      c.set('actor', { user_id: localUser, tenant_id: localTenant, scope: 'tenant',
        roles: ['tenant_admin'], permissions: ['tenant.write'], is_super_admin: false } as CurrentActor);
      await next();
    });
    app.route('/', authRouter());
    app.onError((error, c) => c.json({ error: error.message }, 500));
    try {
      globalThis.fetch = (async () => Response.json(portal)) as unknown as typeof fetch;
      const response = await app.request(
        `http://localhost/auth/portal/callback?code=${crypto.randomUUID()}:secret`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('验证本地登录并关联');
      expect(challenge).toStartWith('documind:portal:link:');
      expect(queries).toHaveLength(4);
      candidates = [];
      const noMatch = await app.request(
        `http://localhost/auth/portal/callback?code=${crypto.randomUUID()}:secret`);
      expect((await noMatch.text())).toContain('确认无历史账号，创建新账号');
      const ticketResponse = await app.request('http://localhost/api/auth/portal/ticket', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: `${crypto.randomUUID()}:secret` }),
      });
      expect(ticketResponse.status).toBe(409);
      const ticketBody = await ticketResponse.json() as { code: string; challenge: string };
      expect(ticketBody.code).toBe('PORTAL_LINK_REQUIRED');
      expect(ticketBody.challenge).toBe(challenge?.split(':').at(-1) ?? '');
      expect(JSON.parse(pending).user_ids).toEqual([]);
      const localToken = await issueToken(state.config, {
        user_id: localUser, tenant_id: localTenant, scope: 'tenant', roles: ['tenant_admin'],
      } as CurrentActor, 'local-session');
      const link = (challengeId: string) => app.request('http://localhost/api/auth/portal/link', {
        method: 'POST',
        headers: { Authorization: `Bearer ${localToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge: challengeId, explicit_link: true }),
      });
      expect((await link(ticketBody.challenge)).status).toBe(500);
      expect(linked).toBe(false);
      expect(memberAttributes).toEqual({});
      expect(audits).toEqual([]);
      expect(portalSessions).toBe(0);
      failLinkAudit = false;
      const retry = await app.request('http://localhost/api/auth/portal/ticket', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: `${crypto.randomUUID()}:secret` }),
      });
      expect(retry.status).toBe(409);
      const retryBody = await retry.json() as { challenge: string };
      expect(retryBody.challenge).not.toBe(ticketBody.challenge);
      const result = await link(retryBody.challenge);
      expect(result.status).toBe(200);
      const body = await result.json() as { auth: { userId: string; tenantId: string; token: string } };
      expect([body.auth.userId, body.auth.tenantId]).toEqual([localUser, localTenant]);
      expect((await claimsFromAuthorizationHeader(state.config, `Bearer ${body.auth.token}`)).auth_source)
        .toBe('portal');
      expect(linked).toBe(true);
      expect(memberAttributes.auth_provider).toBe('portal');
      expect(audits).toEqual([{
        tenantId: localTenant, actorId: localUser, action: 'portal.identity.link.verified',
        resourceId: localUser, detail: {
          portal_user_id: portal.user_id, portal_tenant_id: portal.tenant_id,
          local_user_id: localUser, local_tenant_id: localTenant,
        },
      }]);
      expect(portalSessions).toBe(1);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
  test('member insertion failure rolls back identity and mapping, then ticket retry succeeds', async () => {
    const localTenant = '33333333-3333-4333-8333-333333333333';
    const portal = {
      user_id: '11111111-1111-4111-8111-111111111111', username: 'new-user',
      display_name: 'New User', email: 'new@example.test',
      tenant_id: '22222222-2222-4222-8222-222222222222', tenant_code: 'portal-org',
      system_code: 'documind', system_roles: ['user'], permissions: ['documind:chat:ask'],
      expires_at: Math.floor(Date.now() / 1000) + 60,
    };
    let userId: string | null = null;
    let mappingId: string | null = null;
    let member: { roles: string[]; attributes: unknown } | null = null;
    let failMember = true;
    let attempts = 0;
    const sql = Object.assign((strings: TemplateStringsArray, ...args: unknown[]) => {
      const query = strings.join('?');
      if (query.includes('SELECT m.tenant_id')) return Promise.resolve([
        { tenant_id: localTenant, status: 'active' },
      ]);
      if (query.includes('SELECT local_user_id AS id FROM portal_identity_mapping')) {
        return Promise.resolve(mappingId ? [{ id: mappingId }] : []);
      }
      if (query.includes('SELECT u.id, u.sso_subject')) return Promise.resolve([]);
      if (query.includes('SELECT origin FROM portal_tenant_mapping')) return Promise.resolve([
        { origin: 'approved' },
      ]);
      if (query.includes('INSERT INTO audit_log')) return Promise.resolve([]);
      if (query.includes('SELECT avatar_url')) return Promise.resolve([{ avatar_url: null }]);
      if (query.includes('SELECT id, name, slug, plan, status FROM tenant')) return Promise.resolve([{
        id: localTenant, name: 'Local tenant', slug: 'local', plan: 'enterprise', status: 'active',
      }]);
      if (query.includes('SELECT id, login_id')) return Promise.resolve(userId ? [{
        id: userId, login_id: 'portal-new', email: portal.email, name: portal.display_name, status: 'active',
      }] : []);
      if (query.includes('SELECT EXISTS')) return Promise.resolve([{ active: false }]);
      if (query.includes('SELECT tm.roles')) return Promise.resolve(member ? [member] : []);
      if (query.includes('FROM knowledge_base')) return Promise.resolve([]);
      throw new Error(`unexpected committed query ${query}`);
    }, {
      json: (value: unknown) => value,
      begin: async (run: (tx: Sql) => Promise<unknown>) => {
        attempts++;
        let pendingUser = userId;
        let pendingMapping = mappingId;
        let pendingMember = member;
        const tx = Object.assign((strings: TemplateStringsArray, ...args: unknown[]) => {
          const query = strings.join('?');
          if (query.includes('FROM portal_identity_mapping pim')) return Promise.resolve(pendingMapping
            ? [{ id: pendingMapping, status: 'active' }] : []);
          if (query.includes('SELECT roles, attributes FROM tenant_member')) {
            return Promise.resolve(pendingMember ? [pendingMember] : []);
          }
          if (query.includes('SELECT origin FROM portal_tenant_mapping')) return Promise.resolve([
            { origin: 'approved' },
          ]);
          if (query.includes('SELECT id FROM app_user WHERE lower(email)')) return Promise.resolve([]);
          if (query.includes('INSERT INTO app_user')) {
            pendingUser = String(args[0]);
            return Promise.resolve([]);
          }
          if (query.includes('INSERT INTO portal_identity_mapping')) {
            pendingMapping = String(args[2]);
            return Promise.resolve([{ local_user_id: pendingMapping }]);
          }
          if (query.includes('INSERT INTO tenant_member')) {
            if (failMember) throw new Error('forced member write failure');
            pendingMember = { roles: args[2] as string[], attributes: args[3] };
            return Promise.resolve([]);
          }
          throw new Error(`unexpected transaction query ${query}`);
        }, { json: (value: unknown) => value }) as unknown as Sql;
        const result = await run(tx);
        userId = pendingUser;
        mappingId = pendingMapping;
        member = pendingMember;
        return result;
      },
    }) as unknown as Sql;
    let pending = '';
    const redis = {
      set: async (key: string, value: string) => {
        if (key.startsWith('documind:portal:link:')) pending = value;
        return 'OK';
      },
      get: async () => pending,
      del: async () => { pending = ''; return 1; },
    };
    const state = { sql, redis, config: {
      authLoginMode: 'portal', portalBaseUrl: 'http://portal.test',
      portalExchangeEndpoint: '/exchange', jwtSecret: 'transaction-test', authTokenExpireHours: 1,
    } } as unknown as AppState;
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('appState', state); await next(); });
    app.route('/', authRouter());
    app.onError((error, c) => c.json({ error: error.message },
      error instanceof AppError ? error.httpStatus as 401 : 500));
    const oldFetch = globalThis.fetch;
    const usedTickets: string[] = [];
    try {
      globalThis.fetch = (async (_input, init) => {
        const payload: unknown = JSON.parse(String(init?.body));
        if (!payload || typeof payload !== 'object'
          || !('code' in payload) || typeof payload.code !== 'string') throw new Error('missing ticket');
        const code = payload.code;
        if (usedTickets.includes(code)) return new Response(null, { status: 401 });
        usedTickets.push(code);
        return Response.json(portal);
      }) as typeof fetch;
      const requestTicket = (create: boolean) => app.request('http://localhost/api/auth/portal/ticket', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: `${crypto.randomUUID()}:secret`, create_intent: create }),
      });
      const undecided = await requestTicket(false);
      expect(undecided.status).toBe(409);
      expect([userId, mappingId, member]).toEqual([null, null, null]);
      const undecidedBody: unknown = await undecided.json();
      if (!undecidedBody || typeof undecidedBody !== 'object'
        || !('challenge' in undecidedBody) || typeof undecidedBody.challenge !== 'string') {
        throw new Error('missing link challenge');
      }
      const challenge = undecidedBody.challenge;
      const failed = await app.request('http://localhost/api/auth/portal/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge }),
      });
      expect(failed.status).toBe(500);
      expect([userId, mappingId, member]).toEqual([null, null, null]);
      failMember = false;
      const retried = await requestTicket(true);
      expect(retried.status).toBe(200);
      const login: unknown = await retried.json();
      if (!login || typeof login !== 'object' || !('user' in login)
        || !login.user || typeof login.user !== 'object'
        || !('id' in login.user)) throw new Error('missing linked identity');
      expect(login.user.id).toBe(userId);
      expect(mappingId).toBe(userId);
      expect(member as unknown).toEqual({
        roles: ['end_user'], attributes: expect.objectContaining({ auth_provider: 'portal' }),
      });
      expect(attempts).toBe(2);
      expect(usedTickets).toHaveLength(2);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
  test('slugify keeps ascii words', () => {
    expect(slugify('Acme Corp_01')).toBe('acme-corp-01');
  });
});
