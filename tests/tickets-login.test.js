'use strict';

/**
 * issues/019 — "Tiquets" link in the side menu.
 *
 * GET /api/me/tickets-login returns a login URL for the tickets site
 * (esstrapis-tickets). The token must decrypt with the same scheme the tickets
 * site uses (AES-256-GCM, HKDF key from the tenant API key, tenant as AAD), and
 * the API key must never appear in the URL.
 */

const crypto = require('crypto');
const path = require('path');

const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'me', 'controllers', 'me.js');
const SERVICE = path.join(__dirname, '..', 'src', 'services', 'tickets-sso.js');

const API_KEY = 'test-api-key-0123456789abcdefghijklmnop';

// Same decryption as esstrapis-tickets lib/sso.js readToken().
function decrypt(token, tenant, apiKey) {
  const raw = Buffer.from(token, 'base64url');
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(apiKey, 'utf8'), 'esstrapis-tickets-sso', tenant, 32));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(tenant, 'utf8'));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8'));
}

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
    global.strapi = { contentType: () => ({ kind: 'singleType' }) };
    process.env.TICKETS_TENANT = 'coop-a';
    process.env.TICKETS_SSO_KEY = API_KEY;
    delete process.env.TICKETS_URL;
    ctrl = require(CONTROLLER)({ strapi: global.strapi });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    delete global.strapi;
  });

  test('returns a tickets login URL for the current user', async () => {
    const ctx = fakeCtx({ id: 3, username: 'Núria', email: 'nuria@coop-a.cat' });
    const before = Math.floor(Date.now() / 1000);
    const { url } = await ctrl.ticketsLogin(ctx);

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://tiquets.esstrapis.org/sso');
    expect(parsed.searchParams.get('tenant')).toBe('coop-a');
    expect(url).not.toContain(API_KEY);
    expect(ctx.headers['Cache-Control']).toBe('no-store');

    const payload = decrypt(parsed.searchParams.get('token'), 'coop-a', API_KEY);
    expect(payload.email).toBe('nuria@coop-a.cat');
    expect(payload.name).toBe('Núria');
    expect(payload.exp).toBeGreaterThanOrEqual(before + 60);
    expect(payload.exp).toBeLessThanOrEqual(before + 600);
    expect(payload.nonce.length).toBeGreaterThanOrEqual(16);
  });

  test('the token only decrypts with this tenant and key', async () => {
    const { url } = await ctrl.ticketsLogin(fakeCtx({ username: 'a', email: 'a@coop-a.cat' }));
    const token = new URL(url).searchParams.get('token');
    expect(() => decrypt(token, 'coop-b', API_KEY)).toThrow();
    expect(() => decrypt(token, 'coop-a', 'another-key')).toThrow();
  });

  test('each call makes a different, single-use token', async () => {
    const user = { username: 'a', email: 'a@coop-a.cat' };
    const a = await ctrl.ticketsLogin(fakeCtx(user));
    const b = await ctrl.ticketsLogin(fakeCtx(user));
    expect(a.url).not.toBe(b.url);
  });

  test('uses TICKETS_URL when set', async () => {
    process.env.TICKETS_URL = 'http://localhost:3000/';
    const { url } = await ctrl.ticketsLogin(fakeCtx({ username: 'a', email: 'a@coop-a.cat' }));
    expect(url.startsWith('http://localhost:3000/sso?tenant=coop-a&token=')).toBe(true);
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

  test('ticketsConfig needs both tenant and key', () => {
    const { ticketsConfig } = require(SERVICE);
    expect(ticketsConfig({ TICKETS_TENANT: 'x' })).toBeNull();
    expect(ticketsConfig({ TICKETS_SSO_KEY: 'k' })).toBeNull();
    expect(ticketsConfig({ TICKETS_TENANT: ' x ', TICKETS_SSO_KEY: 'k', TICKETS_URL: 'https://t.example/' }))
      .toEqual({ tenant: 'x', apiKey: 'k', baseUrl: 'https://t.example' });
  });
});
