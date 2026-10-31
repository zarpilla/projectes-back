'use strict';

/**
 * Password minimum (2026-10-31): passwords only needed 6 characters, checked
 * by the front. Now every way to set one (reset link, own change, register,
 * admin creating or editing a user) must meet services/password-policy, the
 * same for every tenant; an admin's change ends the user's other sessions; a
 * login with a weak password answers `passwordWeak: true`.
 */

const path = require('path');

const POLICY = path.join(__dirname, '..', 'src', 'services', 'password-policy');
const EXTENSION = path.join(__dirname, '..', 'src', 'extensions', 'users-permissions', 'strapi-server.js');

const ME = { name: 'Cooperativa La Dotzena' };
const USERS = {
  1: { id: 1, email: 'admin@example.org', username: 'admin', permissions: [{ permission: 'admin' }] },
  7: {
    id: 7,
    email: 'maria.puig@example.org',
    username: 'mpuig',
    fullname: 'Maria Puig Soler',
    resetPasswordToken: 'code-7',
    permissions: [{ permission: 'hours' }],
  },
};

let invalidateRefreshToken;

function stubStrapi() {
  invalidateRefreshToken = jest.fn(async () => {});
  global.strapi = {
    log: { warn: jest.fn(), info: jest.fn() },
    sessionManager: jest.fn(() => ({ invalidateRefreshToken })),
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where = {} } = {}) => {
          if (uid === 'api::me.me') return ME;
          if (where.id) return USERS[where.id] || null;
          if (where.resetPasswordToken) {
            return Object.values(USERS).find((u) => u.resetPasswordToken === where.resetPasswordToken) || null;
          }
          return null;
        }),
      })),
    },
  };
}

describe('passwordProblem', () => {
  let passwordProblem;
  beforeEach(() => {
    jest.resetModules();
    ({ passwordProblem } = require(POLICY));
  });

  it.each([
    ['', 'Cal una clau'],
    ['Curta-123', '10 caràcters'],
    ['aaaaaaaaaaaa', 'repeteix'],
    ['1212121212', 'repeteix'],
    ['password1234', 'comuna'],
    ['Barcelona2026!', 'comuna'],
    ['contrasenya123', 'comuna'],
    ['1234567890', 'comuna'],
    ['qwertyuiop', 'comuna'],
    ['ñ'.repeat(40) + 'abcdefghij', 'massa llarga'],
  ])('refuses %j', (password, message) => {
    expect(passwordProblem(password)).toContain(message);
  });

  it('refuses the e-mail, username or names of the person and the entity', () => {
    const context = { email: 'maria.puig@example.org', username: 'mpuig', names: ['Maria Puig', 'La Dotzena'] };
    expect(passwordProblem('maria.puig-2026', context)).toContain('correu');
    expect(passwordProblem('soc-la-MARIA-77', context)).toContain('correu');
    expect(passwordProblem('dotzena-2026-x', context)).toContain('correu');
    // short words («la») don't count
    expect(passwordProblem('blava-la-tardor', context)).toBeNull();
  });

  it.each(['cavall bateria grapa', 'Tardor-Blava-Mar', 'x7#kQ2!pLm9z', 'E2e-ci-12345'])('accepts %j', (password) => {
    expect(passwordProblem(password, { email: 'e2e@example.org', username: 'e2e' })).toBeNull();
  });
});

describe('users-permissions extension: password policy', () => {
  function plugin() {
    return {
      controllers: {
        user: {
          create: jest.fn(async (ctx) => { ctx.body = 'created'; }),
          update: jest.fn(async (ctx) => { ctx.body = 'updated'; }),
        },
        auth: () => ({
          forgotPassword: jest.fn(),
          resetPassword: jest.fn(async (ctx) => { ctx.body = 'reset'; }),
          changePassword: jest.fn(async (ctx) => { ctx.body = 'changed'; }),
          register: jest.fn(async (ctx) => { ctx.body = 'registered'; }),
          callback: jest.fn(async (ctx) => { ctx.body = { jwt: 'jwt', user: { id: 7 } }; }),
        }),
      },
    };
  }

  const ctxWith = (body, { user = { id: 1 }, id = '7' } = {}) => ({ state: { user }, params: { id }, request: { body } });

  let p;
  let auth;
  beforeEach(() => {
    jest.resetModules();
    stubStrapi();
    p = require(EXTENSION)(plugin());
    auth = p.controllers.auth({});
  });

  it('an admin editing a user: refuses a weak password, saves a good one and ends her sessions', async () => {
    await expect(p.controllers.user.update(ctxWith({ password: 'mpuig12345' }))).rejects.toMatchObject({
      name: 'ValidationError',
    });
    await expect(p.controllers.user.update(ctxWith({ password: 'Puig-Soler-2026' }))).rejects.toMatchObject({
      name: 'ValidationError',
    });
    expect(invalidateRefreshToken).not.toHaveBeenCalled();

    const ctx = ctxWith({ password: 'cavall bateria grapa' });
    await p.controllers.user.update(ctx);
    expect(ctx.body).toBe('updated');
    expect(invalidateRefreshToken).toHaveBeenCalledWith('7');
  });

  it('an admin editing a user without a password: no check, sessions kept', async () => {
    const ctx = ctxWith({ fullname: 'Maria' });
    await p.controllers.user.update(ctx);
    expect(ctx.body).toBe('updated');
    expect(invalidateRefreshToken).not.toHaveBeenCalled();
  });

  it('an admin changing her own password keeps her session', async () => {
    await p.controllers.user.update(ctxWith({ password: 'cavall bateria grapa' }, { id: '1' }));
    expect(invalidateRefreshToken).not.toHaveBeenCalled();
  });

  it('an admin creating a user: checked against the new user data', async () => {
    await expect(
      p.controllers.user.create(ctxWith({ email: 'joan@example.org', username: 'joan', password: 'joan-2026-casa' })),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    const ctx = ctxWith({ email: 'joan@example.org', username: 'joan', password: 'cavall bateria grapa' });
    await p.controllers.user.create(ctx);
    expect(ctx.body).toBe('created');
  });

  it('a non-admin is refused before any password check', async () => {
    await expect(
      p.controllers.user.update(ctxWith({ password: 'abc' }, { user: { id: 7 } })),
    ).rejects.toMatchObject({ name: 'ForbiddenError' });
  });

  it('the reset link: checked against the owner of the code', async () => {
    await expect(
      auth.resetPassword(ctxWith({ code: 'code-7', password: 'maria-1234567', passwordConfirmation: 'maria-1234567' })),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    await expect(
      auth.resetPassword(ctxWith({ code: 'code-7', password: 'curta', passwordConfirmation: 'curta' })),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    const ctx = ctxWith({ code: 'code-7', password: 'cavall bateria grapa', passwordConfirmation: 'cavall bateria grapa' });
    await auth.resetPassword(ctx);
    expect(ctx.body).toBe('reset');
  });

  it('the reset link with a wrong code is left to the plugin', async () => {
    const ctx = ctxWith({ code: 'nope', password: 'cavall bateria grapa', passwordConfirmation: 'x' });
    await auth.resetPassword(ctx);
    expect(ctx.body).toBe('reset');
  });

  it('changing one\'s own password and register are checked too', async () => {
    await expect(
      auth.changePassword(ctxWith({ currentPassword: 'x', password: 'password123' }, { user: { id: 7 } })),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    await expect(
      auth.register(ctxWith({ email: 'a@b.cat', username: 'nova', password: '123456' })),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('a login flags a weak password, and only a weak one', async () => {
    const weak = ctxWith({ identifier: 'mpuig', password: 'mpuig123' });
    await auth.callback(weak);
    expect(weak.body.passwordWeak).toBe(true);

    const strong = ctxWith({ identifier: 'mpuig', password: 'cavall bateria grapa' });
    await auth.callback(strong);
    expect(strong.body.passwordWeak).toBe(false);
  });
});
