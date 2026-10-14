'use strict';

/**
 * issues/040 (2026-10-14): the e2e workflow in projectes-front runs the
 * production image (NODE_ENV=production) over plain http://localhost:1339 with
 * no proxy. users-permissions then sets the refresh cookie `secure`, Koa throws
 * "Cannot send secure cookie over unencrypted connection" and every
 * POST /api/auth/local answers 500. REFRESH_COOKIE_SECURE=false turns the flag
 * off there; left unset, production keeps a secure cookie.
 */

const path = require('path');
const { env } = require('@strapi/utils');

// The plugin's `exports` map hides its internals: load the real helper by path,
// so the test follows whatever rule the installed users-permissions applies.
const { buildRefreshCookieOptions } = require(
  path.join(__dirname, '../node_modules/@strapi/plugin-users-permissions/dist/server/utils/refresh-cookie-options.js')
).__require();

const loadSessions = () => {
  jest.resetModules();
  return require('../config/plugins')({ env })['users-permissions'].config.sessions;
};

describe('refresh cookie secure flag', () => {
  const saved = process.env.REFRESH_COOKIE_SECURE;
  afterEach(() => {
    if (saved === undefined) delete process.env.REFRESH_COOKIE_SECURE;
    else process.env.REFRESH_COOKIE_SECURE = saved;
  });

  it('stays secure in production when REFRESH_COOKIE_SECURE is unset', () => {
    delete process.env.REFRESH_COOKIE_SECURE;
    expect(buildRefreshCookieOptions(loadSessions(), true).secure).toBe(true);
  });

  it('is not secure in production with REFRESH_COOKIE_SECURE=false (e2e CI)', () => {
    process.env.REFRESH_COOKIE_SECURE = 'false';
    expect(buildRefreshCookieOptions(loadSessions(), true).secure).toBe(false);
  });

  it('keeps the cookie httpOnly', () => {
    process.env.REFRESH_COOKIE_SECURE = 'false';
    const sessions = loadSessions();
    expect(sessions.httpOnly).toBe(true);
    expect(buildRefreshCookieOptions(sessions, true).httpOnly).toBe(true);
  });
});
