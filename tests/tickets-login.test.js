'use strict';

/**
 * issues/019 — "Tiquets" link in the side menu.
 *
 * GET /api/me/tickets-login returns a login URL for the tickets site
 * (esstrapis-tickets). The token must decrypt with the same scheme the tickets
 * site uses (AES-256-GCM, HKDF key from the shared TICKETS_SSO_KEY), carry the
 * tenant (slug of `me.name`, unless TICKETS_TENANT overrides it), and the secret
 * must never appear in the URL.
 */

const crypto = require('crypto');
const path = require('path');

const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'me', 'controllers', 'me.js');
const SERVICE = path.join(__dirname, '..', 'src', 'services', 'tickets-sso.js');

const SECRET = 'shared-sso-secret-0123456789abcdefghijklmnop';

// Same decryption as esstrapis-tickets lib/sso.js readToken().
function decrypt(token, secret) {
  const raw = Buffer.from(token, 'base64url');
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'esstrapis-tickets-sso', 'v2', 32));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from('esstrapis-tickets-sso/v2', 'utf8'));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8'));
}

const tokenOf = (url) => new URL(url).searchParams.get('token');

function fakeCtx(user) {
  const headers = {};
  return {
    state: { user },
    headers,
    set: (k, v) => { headers[k] = v; },
    unauthorized: jest.fn(() => 'unauthorized'),
    badRequest: jest.fn((msg) => `bad request: ${msg}`),
  };
}

describe('me.ticketsLogin', () => {
  const savedEnv = { ...process.env };
  let ctrl;

  beforeEach(() => {
    jest.resetModules();
    global.strapi = {
      contentType: () => ({ kind: 'singleType' }),
      documents: () => ({ findFirst: async () => ({ name: 'Coop A, SCCL' }) }),
    };
    delete process.env.TICKETS_TENANT;
    delete process.env.TICKETS_URL;
    process.env.TICKETS_SSO_KEY = SECRET;
    ctrl = require(CONTROLLER)({ strapi: global.strapi });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    delete global.strapi;
  });

  test('returns a tickets login URL carrying the user and the tenant', async () => {
    const ctx = fakeCtx({ id: 3, username: 'Núria', email: 'nuria@coop-a.cat' });
    const before = Math.floor(Date.now() / 1000);
    const { url } = await ctrl.ticketsLogin(ctx);

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://tiquets.esstrapis.org/sso');
    expect([...parsed.searchParams.keys()]).toEqual(['token']);
    expect(url).not.toContain(SECRET);
    expect(ctx.headers['Cache-Control']).toBe('no-store');

    const payload = decrypt(tokenOf(url), SECRET);
    expect(payload).toMatchObject({
      tenant: 'coop-a-sccl',
      tenantName: 'Coop A, SCCL',
      email: 'nuria@coop-a.cat',
      name: 'Núria',
    });
    expect(payload.exp).toBeGreaterThanOrEqual(before + 60);
    expect(payload.exp).toBeLessThanOrEqual(before + 600);
    expect(payload.nonce.length).toBeGreaterThanOrEqual(16);
  });

  test('the token only decrypts with the shared secret', async () => {
    const { url } = await ctrl.ticketsLogin(fakeCtx({ username: 'a', email: 'a@coop-a.cat' }));
    expect(() => decrypt(tokenOf(url), 'another-secret')).toThrow();
  });

  test('each call makes a different, single-use token', async () => {
    const user = { username: 'a', email: 'a@coop-a.cat' };
    const a = await ctrl.ticketsLogin(fakeCtx(user));
    const b = await ctrl.ticketsLogin(fakeCtx(user));
    expect(a.url).not.toBe(b.url);
    expect(decrypt(tokenOf(a.url), SECRET).nonce).not.toBe(decrypt(tokenOf(b.url), SECRET).nonce);
  });

  test('uses TICKETS_URL when set', async () => {
    process.env.TICKETS_URL = 'http://localhost:3000/';
    const { url } = await ctrl.ticketsLogin(fakeCtx({ username: 'a', email: 'a@coop-a.cat' }));
    expect(url.startsWith('http://localhost:3000/sso?token=')).toBe(true);
  });

  test('TICKETS_TENANT overrides the instance name', async () => {
    process.env.TICKETS_TENANT = 'custom';
    const { url } = await ctrl.ticketsLogin(fakeCtx({ username: 'a', email: 'a@coop-a.cat' }));
    expect(decrypt(tokenOf(url), SECRET)).toMatchObject({ tenant: 'custom', tenantName: 'Coop A, SCCL' });
  });

  test('refuses when the instance has no name and no TICKETS_TENANT', async () => {
    global.strapi.documents = () => ({ findFirst: async () => ({ name: '  ' }) });
    const ctx = fakeCtx({ username: 'a', email: 'a@coop-a.cat' });
    expect(await ctrl.ticketsLogin(ctx)).toBe('bad request: Tickets are not configured on this instance');
  });

  test('refuses when tickets are not configured, the user has no email, or nobody is logged in', async () => {
    let ctx = fakeCtx(undefined);
    expect(await ctrl.ticketsLogin(ctx)).toBe('unauthorized');

    ctx = fakeCtx({ username: 'a', email: '' });
    expect(await ctrl.ticketsLogin(ctx)).toBe('bad request: Your user has no email address');

    delete process.env.TICKETS_SSO_KEY;
    ctx = fakeCtx({ username: 'a', email: 'a@coop-a.cat' });
    expect(await ctrl.ticketsLogin(ctx)).toBe('bad request: Tickets are not configured on this instance');
  });

  test('tenantSlug makes valid tickets tenant names from instance names', () => {
    const { tenantSlug } = require(SERVICE);
    expect(tenantSlug('Fusteria La Serra, SCCL')).toBe('fusteria-la-serra-sccl');
    expect(tenantSlug('  L\'Olivera, SCCL ')).toBe('l-olivera-sccl');
    expect(tenantSlug('Cooperativa Ça Marxa · 2026')).toBe('cooperativa-ca-marxa-2026');
    expect(tenantSlug('x'.repeat(80))).toHaveLength(63);
    expect(tenantSlug('')).toBe('');
    expect(tenantSlug(null)).toBe('');
  });

  test('ticketsConfig needs a tenant (override or instance name) and the secret', () => {
    const { ticketsConfig } = require(SERVICE);
    expect(ticketsConfig({ TICKETS_TENANT: 'xy' })).toBeNull();
    expect(ticketsConfig({ TICKETS_SSO_KEY: 'k' })).toBeNull();
    expect(ticketsConfig({ TICKETS_SSO_KEY: 'k' }, 'Coop A')).toEqual({
      tenant: 'coop-a', tenantName: 'Coop A', secret: 'k', baseUrl: 'https://tiquets.esstrapis.org',
    });
    expect(ticketsConfig({ TICKETS_TENANT: ' xy ', TICKETS_SSO_KEY: 'k', TICKETS_URL: 'https://t.example/' }, ''))
      .toEqual({ tenant: 'xy', tenantName: 'xy', secret: 'k', baseUrl: 'https://t.example' });
  });
});
