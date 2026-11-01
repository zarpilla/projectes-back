'use strict';

/**
 * issues/400 (security review round 3, 2026-11-01): login tries were limited
 * per IP only (issues/376), so from many addresses (an IPv6 /64, a botnet) one
 * account's password could be guessed without end, and every member sees the
 * usernames. Now 20 wrong passwords for one identifier within an hour lock that
 * identifier from any address; a correct login clears the count.
 */

describe('failed logins per account (issues/400)', () => {
  let attempts;
  beforeEach(() => {
    jest.resetModules();
    attempts = require('../src/services/login-attempts');
  });

  it('locks after 20 failures within an hour, case and spaces aside', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 19; i++) attempts.recordFailure('Admin@Coop.cat', t0 + i);
    expect(attempts.isLocked('admin@coop.cat', t0 + 20)).toBe(false);
    attempts.recordFailure(' admin@coop.cat ', t0 + 21);
    expect(attempts.isLocked('ADMIN@coop.cat', t0 + 22)).toBe(true);
    expect(attempts.isLocked('other', t0 + 22)).toBe(false);
    expect(attempts.isLocked('admin@coop.cat', t0 + attempts.WINDOW_MS)).toBe(false);
  });

  it('a correct login clears the count', () => {
    for (let i = 0; i < 20; i++) attempts.recordFailure('jordi');
    attempts.recordSuccess('Jordi');
    expect(attempts.isLocked('jordi')).toBe(false);
  });

  function plugin(callbackImpl) {
    const p = {
      controllers: {
        user: { create: jest.fn(), update: jest.fn() },
        auth: () => ({
          forgotPassword: jest.fn(),
          resetPassword: jest.fn(),
          changePassword: jest.fn(),
          register: jest.fn(),
          callback: callbackImpl,
        }),
      },
      services: {},
      routes: {},
    };
    require('../src/extensions/users-permissions/strapi-server')(p);
    return p.controllers.auth({});
  }

  it('the login counts wrong passwords only, and refuses once locked', async () => {
    global.strapi = { log: { warn: jest.fn() }, db: { query: () => ({ findOne: async () => null }) } };
    const { errors } = require('@strapi/utils');
    let right = false;
    const auth = plugin(async (ctx) => {
      if (!right) throw new errors.ValidationError('Invalid identifier or password');
      ctx.body = { jwt: 'x', user: { id: 1 } };
    });
    const ctx = () => ({ params: { provider: 'local' }, request: { body: { identifier: 'maria', password: 'no' } } });
    for (let i = 0; i < 20; i++) await expect(auth.callback(ctx())).rejects.toThrow('Invalid identifier');
    right = true;
    await expect(auth.callback(ctx())).rejects.toMatchObject({ name: 'RateLimitError' });
    attempts.recordSuccess('maria');
    const ok = ctx();
    await auth.callback(ok);
    expect(ok.body.jwt).toBe('x');
  });
});
