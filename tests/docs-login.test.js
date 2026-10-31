'use strict';

/**
 * Documentation site (esstrapis-docs) login link.
 *
 * GET /api/me/docs-login?route=/x returns a login URL for the docs site. The token
 * must decrypt with the scheme the docs site uses (AES-256-GCM, HKDF key from the
 * shared DOCS_SSO_KEY, its own info and AAD), carry the tenant, the user's app
 * permissions (they pick the chapters she reads) and the screen she is on, and the
 * secret must never appear in the URL. A tickets token must not be one for docs.
 */

const crypto = require('crypto');
const path = require('path');

const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'me', 'controllers', 'me.js');

const SECRET = 'shared-docs-secret-0123456789abcdefghijklmnop';

// Same decryption as esstrapis-docs lib/sso.js readToken().
function decrypt(token, secret, { info = 'esstrapis-docs-sso', version = 'v1', aad = 'esstrapis-docs-sso/v1' } = {}) {
  const raw = Buffer.from(token, 'base64url');
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), info, version, 32));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8'));
}

const tokenOf = (url) => new URL(url).searchParams.get('token');

function fakeCtx(user, query = {}) {
  const headers = {};
  return {
    state: { user },
    query,
    headers,
    set: (k, v) => { headers[k] = v; },
    unauthorized: jest.fn(() => 'unauthorized'),
    badRequest: jest.fn((msg) => `bad request: ${msg}`),
  };
}

describe('me.docsLogin', () => {
  const savedEnv = { ...process.env };
  let ctrl;
  let permissions;

  let kept;

  beforeEach(() => {
    jest.resetModules();
    kept = null;
    permissions = [{ permission: 'projects' }, { permission: 'hours' }];
    global.strapi = {
      contentType: () => ({ kind: 'singleType' }),
      documents: () => ({ findFirst: async () => ({ name: 'Coop A, SCCL' }) }),
      // Strapi's core store, where the SSO tenant is kept (issues/379)
      store: () => ({ get: async () => kept, set: async ({ value }) => { kept = value; } }),
      db: { query: () => ({ findOne: async () => ({ id: 3, permissions }) }) },
    };
    // Blank, not deleted: requiring the controller loads @strapi/core, which runs
    // dotenv, and dotenv refills deleted variables from a local .env.
    process.env.TICKETS_TENANT = '';
    process.env.DOCS_URL = '';
    process.env.DOCS_SSO_KEY = SECRET;
    ctrl = require(CONTROLLER)({ strapi: global.strapi });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    delete global.strapi;
  });

  test('returns a docs login URL with the user, the tenant, her permissions and the screen', async () => {
    const ctx = fakeCtx({ id: 3, username: 'Núria', email: 'nuria@coop-a.cat' }, { route: '/project/642' });
    const before = Math.floor(Date.now() / 1000);
    const { url } = await ctrl.docsLogin(ctx);

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://docs.esstrapis.org/sso');
    expect([...parsed.searchParams.keys()]).toEqual(['token']);
    expect(url).not.toContain(SECRET);
    expect(ctx.headers['Cache-Control']).toBe('no-store');

    const payload = decrypt(tokenOf(url), SECRET);
    expect(payload).toMatchObject({
      tenant: 'coop-a-sccl',
      tenantName: 'Coop A, SCCL',
      email: 'nuria@coop-a.cat',
      name: 'Núria',
      roles: ['projects', 'hours'],
      route: '/project/642',
    });
    expect(payload.exp).toBeGreaterThanOrEqual(before + 60);
    expect(payload.exp).toBeLessThanOrEqual(before + 600);
    expect(payload.nonce.length).toBeGreaterThanOrEqual(16);
  });

  test('is not a tickets token, even with the same secret', async () => {
    const { url } = await ctrl.docsLogin(fakeCtx({ id: 3, username: 'a', email: 'a@coop-a.cat' }));
    expect(() => decrypt(tokenOf(url), SECRET, { info: 'esstrapis-tickets-sso', version: 'v2', aad: 'esstrapis-tickets-sso/v2' })).toThrow();
    expect(() => decrypt(tokenOf(url), 'another-secret')).toThrow();
  });

  test('leaves out routes that are not app routes, and works without permissions or email', async () => {
    permissions = [];
    for (const route of ['https://evil.example/x', '//evil.example', 'tresoreria', '/a b', '/' + 'x'.repeat(400)]) {
      const { url } = await ctrl.docsLogin(fakeCtx({ id: 3, username: 'a', email: '' }, { route }));
      const payload = decrypt(tokenOf(url), SECRET);
      expect(payload.route).toBeUndefined();
      expect(payload.roles).toEqual([]);
      expect(payload.name).toBe('a');
    }
  });

  test('uses DOCS_URL and TICKETS_TENANT when set', async () => {
    process.env.DOCS_URL = 'http://localhost:3310/';
    process.env.TICKETS_TENANT = 'custom';
    const { url } = await ctrl.docsLogin(fakeCtx({ id: 3, username: 'a', email: 'a@coop-a.cat' }));
    expect(url.startsWith('http://localhost:3310/sso?token=')).toBe(true);
    expect(decrypt(tokenOf(url), SECRET)).toMatchObject({ tenant: 'custom', tenantName: 'Coop A, SCCL' });
  });

  test('refuses when the docs are not configured or nobody is logged in', async () => {
    expect(await ctrl.docsLogin(fakeCtx(undefined))).toBe('unauthorized');
    delete process.env.DOCS_SSO_KEY;
    expect(await ctrl.docsLogin(fakeCtx({ id: 3, username: 'a' }))).toBe('bad request: Documentation is not configured on this instance');
  });
});
