'use strict';

/**
 * POST /api/auth/local returned 500 for valid credentials on every VPS tenant
 * (v5 cutover of buida/demo/webcoop), while a bad identifier correctly
 * returned 400.
 *
 * On success, users-permissions' sendRefreshAuthResponse sets the refresh
 * token cookie with `secure: NODE_ENV === 'production'`
 * (server/utils/refresh-cookie-options.js). nginx terminates TLS and talks
 * plain HTTP to Strapi, so unless Koa trusts X-Forwarded-Proto it computes
 * ctx.protocol === 'http' and the cookies library throws
 * "Cannot send secure cookie over unencrypted connection" -> 500.
 *
 * Koa's trust-proxy flag comes from server.proxy.koa:
 *   @strapi/core/dist/services/server/index.js -> new Koa({ proxy: config.get('server.proxy.koa') })
 */

const http = require('http');
const Koa = require('koa');

const serverConfig = require('../config/server');

function makeEnv(vars) {
  const env = (key, def) => (key in vars ? vars[key] : def);
  env.int = (key, def) => (key in vars ? parseInt(vars[key], 10) : def);
  env.bool = (key, def) => (key in vars ? vars[key] === 'true' || vars[key] === true : def);
  env.array = (key, def) => (key in vars ? String(vars[key]).split(',') : def);
  return env;
}

describe('server.proxy.koa', () => {
  it('is off by default, so a directly exposed instance ignores forwarded headers', () => {
    expect(serverConfig({ env: makeEnv({}) }).proxy).toEqual({ koa: false });
  });

  it('is on when IS_PROXIED=true, which is what the tenant .env sets', () => {
    expect(serverConfig({ env: makeEnv({ IS_PROXIED: 'true' }) }).proxy).toEqual({ koa: true });
  });
});

// Exercises the real koa + cookies packages the app runs on, with the same
// cookie options buildRefreshCookieOptions produces under NODE_ENV=production.
function loginBehindNginx(proxy) {
  return new Promise((resolve, reject) => {
    const app = new Koa({ proxy });
    app.keys = ['test'];
    app.silent = true;
    app.use((ctx) => {
      ctx.cookies.set('strapi_up_refresh', 'refresh-token', {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        overwrite: true,
      });
      ctx.body = { jwt: 'access-token' };
    });

    const server = app.listen(0, () => {
      const req = http.request(
        {
          port: server.address().port,
          path: '/api/auth/local',
          method: 'POST',
          headers: { 'X-Forwarded-Proto': 'https' },
        },
        (res) => {
          res.resume();
          res.on('end', () => server.close(() => resolve(res.statusCode)));
        }
      );
      req.on('error', (err) => server.close(() => reject(err)));
      req.end();
    });
  });
}

describe('secure refresh cookie behind a TLS-terminating proxy', () => {
  it('500s when Koa does not trust the proxy — the bug', async () => {
    await expect(loginBehindNginx(false)).resolves.toBe(500);
  });

  it('succeeds once Koa trusts the proxy', async () => {
    await expect(loginBehindNginx(true)).resolves.toBe(200);
  });
});
