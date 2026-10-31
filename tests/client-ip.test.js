'use strict';

/**
 * issues/376 (security review 2026-10-31): behind nginx → Caddy, Koa took the
 * leftmost X-Forwarded-For, which nginx appends to whatever the client sent.
 * A different X-Forwarded-For on each try skipped the login rate limit (14
 * wrong logins, never a 429). The IP now comes from nginx's X-Real-IP.
 */
const Koa = require('koa');

function ctxFor(app, headers, remote = '127.0.0.1') {
  const req = { headers, socket: { remoteAddress: remote }, url: '/', method: 'POST' };
  const res = { getHeader() {}, setHeader() {}, removeHeader() {} };
  return app.createContext(req, res);
}

async function ipAfter({ proxied, headers }) {
  const app = new Koa({ proxy: proxied });
  const strapi = { config: { get: (key) => (key === 'server.proxy.koa' ? proxied : undefined) } };
  const middleware = require('../src/middlewares/client-ip')({}, { strapi });
  const ctx = ctxFor(app, headers);
  let seen;
  await middleware(ctx, async () => {
    seen = ctx.request.ip;
  });
  return seen;
}

describe('client IP behind the proxies (issues/376)', () => {
  beforeEach(() => jest.resetModules());

  it('ignores the X-Forwarded-For value the client chose', async () => {
    const headers = { 'x-forwarded-for': '10.0.1.7, 9.9.9.7, 127.0.0.1', 'x-real-ip': '9.9.9.7' };
    expect(await ipAfter({ proxied: true, headers })).toBe('9.9.9.7');
  });

  it("keeps Koa's answer without X-Real-IP or with a value that isn't an IP", async () => {
    expect(await ipAfter({ proxied: true, headers: { 'x-forwarded-for': '9.9.9.7' } })).toBe('9.9.9.7');
    expect(
      await ipAfter({ proxied: true, headers: { 'x-forwarded-for': '9.9.9.7', 'x-real-ip': 'evil' } }),
    ).toBe('9.9.9.7');
  });

  it('trusts no header when the app is not proxied', async () => {
    const headers = { 'x-forwarded-for': '10.0.1.7', 'x-real-ip': '10.0.1.8' };
    expect(await ipAfter({ proxied: false, headers })).toBe('127.0.0.1');
  });
});
