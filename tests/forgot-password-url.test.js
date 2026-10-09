'use strict';

/**
 * Regression: issues/021 — "He oblidat la clau de pas" always failed on v5.
 *
 * The front posted { email, url } to auth/forgot-password like on v3, and
 * Strapi 5 rejects unknown keys (400 "this field has unspecified keys: url").
 * Strapi 5 takes the link of the e-mail from the users-permissions advanced
 * setting `email_reset_password` instead, which the ETL'd tenants don't have.
 *
 *   - the plugin extension drops a stray `url` (fronts not yet updated);
 *   - services/ensure-reset-password-url.js fills the setting on boot from
 *     RESET_PASSWORD_URL, or the server URL + the front's /stats/ path.
 */

const path = require('path');

const EXTENSION = path.join(__dirname, '..', 'src', 'extensions', 'users-permissions', 'strapi-server.js');
const ENSURE = path.join(__dirname, '..', 'src', 'services', 'ensure-reset-password-url.js');

function stubStrapi({ advanced = {}, serverUrl = '' } = {}) {
  const stored = { advanced };
  global.strapi = {
    db: { query: jest.fn(() => ({ findOne: jest.fn(async () => null) })) },
    config: { get: jest.fn((key) => (key === 'server.url' ? serverUrl : undefined)) },
    store: jest.fn(() => ({
      get: jest.fn(async ({ key }) => stored[key]),
      set: jest.fn(async ({ key, value }) => { stored[key] = value; }),
    })),
    log: { info: jest.fn(), warn: jest.fn() },
  };
  return stored;
}

function plugin(forgotPassword) {
  return {
    controllers: {
      user: { create: jest.fn(), update: jest.fn() },
      auth: () => ({ forgotPassword, callback: jest.fn() }),
    },
  };
}

describe('forgot password (issues/021)', () => {
  const env = process.env.RESET_PASSWORD_URL;
  beforeEach(() => {
    jest.resetModules();
    delete process.env.RESET_PASSWORD_URL;
  });
  afterAll(() => {
    if (env === undefined) delete process.env.RESET_PASSWORD_URL;
    else process.env.RESET_PASSWORD_URL = env;
  });

  it('drops the `url` the v3 front sent before Strapi validates the body', async () => {
    stubStrapi();
    const forgotPassword = jest.fn(async (ctx) => ctx.request.body);
    const auth = require(EXTENSION)(plugin(forgotPassword)).controllers.auth({ strapi: global.strapi });
    const ctx = { request: { body: { email: 'a@exemple.coop', url: 'https://evil.example/' } } };
    await auth.forgotPassword(ctx);
    expect(forgotPassword).toHaveBeenCalledTimes(1);
    expect(ctx.request.body).toEqual({ email: 'a@exemple.coop' });
  });

  it('fills email_reset_password from the server URL', async () => {
    const stored = stubStrapi({ advanced: { email_confirmation: false }, serverUrl: 'https://coop.example.org/' });
    await require(ENSURE).ensureResetPasswordUrl();
    expect(stored.advanced).toEqual({
      email_confirmation: false,
      email_reset_password: 'https://coop.example.org/stats/#/reset-password',
    });
  });

  it('prefers RESET_PASSWORD_URL', async () => {
    process.env.RESET_PASSWORD_URL = 'https://front.example.org/#/reset-password';
    const stored = stubStrapi({ serverUrl: 'https://coop.example.org' });
    await require(ENSURE).ensureResetPasswordUrl();
    expect(stored.advanced.email_reset_password).toBe('https://front.example.org/#/reset-password');
  });

  it('keeps a URL that is already configured', async () => {
    const stored = stubStrapi({ advanced: { email_reset_password: 'https://set.example/#/reset-password' }, serverUrl: 'https://coop.example.org' });
    await require(ENSURE).ensureResetPasswordUrl();
    expect(stored.advanced.email_reset_password).toBe('https://set.example/#/reset-password');
  });

  it('warns when there is nothing to build it from', async () => {
    const stored = stubStrapi();
    await require(ENSURE).ensureResetPasswordUrl();
    expect(stored.advanced.email_reset_password).toBeUndefined();
    expect(global.strapi.log.warn).toHaveBeenCalled();
  });
});
