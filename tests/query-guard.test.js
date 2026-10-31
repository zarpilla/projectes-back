'use strict';

/**
 * issues/384 (security review 2026-10-31): the custom endpoints pass the
 * request's filters straight to strapi.db.query, so a filter could reach a
 * private field of any related user. A member read an admin's password reset
 * token on a copy of La Diligència with
 * `/orders/table?_where[deposit_user.resetPasswordToken_lt]=…` (1,090 requests,
 * 5.5 s), reset the password and logged in as the admin. The same worked for
 * the bcrypt hash, for a worker on /activities/calendar and for a `projects`
 * user who is not admin. Reset tokens never expired.
 *
 * Guards: the middleware refuses those filters and sorts in every query form,
 * the v3 adapter refuses credentials too, a reset link lasts one hour, and the
 * pending tokens are cleared once.
 */

const ME = 100;

function makeStrapi(permissions, contentTypes = {}) {
  return {
    db: {
      query: jest.fn(() => ({
        findOne: jest.fn(async ({ where }) => ({
          id: where.id,
          permissions: (permissions[where.id] || []).map((permission) => ({ permission })),
        })),
        findMany: jest.fn(async () => []),
      })),
    },
    contentTypes,
    components: {},
  };
}

function ctxFor({ handler, query, userId = ME }) {
  const [, rest] = handler.split('::');
  return {
    method: 'GET',
    query,
    params: {},
    request: {},
    state: {
      user: userId ? { id: userId } : undefined,
      route: { handler, info: { apiName: rest.split('.')[0] } },
    },
  };
}

async function call(permissions, opts, contentTypes) {
  jest.resetModules();
  const strapi = makeStrapi({ [ME]: permissions }, contentTypes);
  const middleware = require('../src/middlewares/app-permissions')({}, { strapi });
  const ctx = ctxFor(opts);
  const next = jest.fn(async () => {
    ctx.body = [];
  });
  await middleware(ctx, next);
  return next;
}

const refused = (permissions, opts, contentTypes) =>
  expect(call(permissions, opts, contentTypes)).rejects.toMatchObject({ name: 'ValidationError' });

describe('filters on private fields (issues/384)', () => {
  const TABLE = 'api::order.order.table';

  it.each([
    ['v3 _where with a dotted path', { _where: { 'deposit_user.resetPasswordToken_lt': 'fb2bcg' } }],
    ['v3 flat operator', { 'owner.password_gt': '$2a$10' }],
    ['v3 nested _or', { _where: { _or: [{ 'owner.resetPasswordToken_contains': 'a' }] } }],
    ['v5 filters', { filters: { owner: { password: { $startsWith: '$2a' } } } }],
    ['the column name', { _where: { 'deposit_user.reset_password_token_lt': 'g' } }],
    ['another case', { _where: { 'deposit_user.RESETPASSWORDTOKEN_lt': 'g' } }],
    ['the confirmation token', { 'owner.confirmationToken_null': 'false' }],
    ['a sort', { _sort: 'owner.password:asc' }],
    ['a v5 sort list', { sort: ['owner.resetPasswordToken:desc'] }],
    ['a filter inside populate', { populate: { owner: { filters: { password: { $startsWith: '$' } } } } }],
  ])('refuses %s, for a member', async (_label, query) => {
    await refused(['orders'], { handler: TABLE, query });
  });

  it('refuses them for a projects user who is not admin, and for a worker', async () => {
    const query = { _where: { 'users_permissions_user.resetPasswordToken_lt': 'g' } };
    await refused(['projects', 'hours'], { handler: 'api::activity.activity.getForCalendar', query });
    await refused(['hours'], { handler: 'api::activity.activity.getForCalendar', query });
    await refused(['admin', 'projects'], { handler: 'api::activity.activity.getForCalendar', query });
  });

  it('refuses them without a session too', async () => {
    await refused([], { handler: 'api::logo.logo.find', query: { 'owner.password_gt': 'a' }, userId: null });
  });

  it('refuses the private attributes of any schema', async () => {
    const contentTypes = {
      'api::me.me': { attributes: { dir3_api_token: { type: 'string', private: true } } },
    };
    await refused(['projects'], { handler: TABLE, query: { 'me.dir3_api_token_starts_with': 'x' } }, contentTypes);
  });

  it("ignores generic names Strapi's internal types mark private (status, type…)", async () => {
    const contentTypes = {
      'admin::session': { attributes: { status: { type: 'string', private: true }, userId: { type: 'string', private: true } } },
      'api::order.order': { attributes: { createdBy: { type: 'relation', private: true } } },
    };
    const queries = [{ _where: { status: 'pending' } }, { _where: { userId_eq: 1 } }, { type: 'income' }, { 'createdBy.id': 1 }];
    for (const query of queries) {
      const next = await call(['projects'], { handler: TABLE, query }, contentTypes);
      expect(next).toHaveBeenCalled();
    }
    await refused(['projects'], { handler: TABLE, query: { 'createdBy.registrationToken_lt': 'g' } }, contentTypes);
  });

  it('refuses salaries and project finances to users without full access only', async () => {
    const salary = { _where: { 'project.leader.monthly_salary_gt': '2000' } };
    await refused(['hours'], { handler: 'api::activity.activity.getForCalendar', query: salary });
    const next = await call(['projects'], { handler: 'api::activity.activity.getForCalendar', query: salary });
    expect(next).toHaveBeenCalled();
    await refused(['hours'], { handler: 'api::project.project.findWithPhasesBoth', query: { balance_gt: '0' } });
  });

  it('lets the filters the screens send through', async () => {
    const queries = [
      { _where: { owner: ME, 'contact.id_in': [1, 2], status_ne: 'cancelled' }, _sort: 'route_date:DESC' },
      { _where: { _or: [{ 'owner.id': ME }, { 'contact.id_in': [7] }] }, _limit: '-1' },
      { filters: { route: { id: { $eq: 3 } } }, sort: ['estimated_delivery_date:asc'] },
      { populate: { owner: { fields: ['username'] }, contact: true }, 'owner.username_contains': 'pass' },
      { _q: 'password' },
    ];
    for (const query of queries) {
      const next = await call(['orders'], { handler: TABLE, query });
      expect(next).toHaveBeenCalled();
    }
  });
});

describe('query-adapter refuses credentials (issues/384)', () => {
  beforeEach(() => jest.resetModules());

  it('throws on a credential, in any form', () => {
    const { adaptQuery } = require('../src/services/query-adapter');
    expect(() => adaptQuery({ _where: { 'leader.resetPasswordToken_lt': 'a' } })).toThrow(/resetPasswordToken/);
    expect(() => adaptQuery({ 'owner.password_gt': 'a' })).toThrow();
    expect(() => adaptQuery({ _sort: 'owner.password:asc' })).toThrow();
    expect(adaptQuery({ 'owner.id': 3 }).filters).toEqual({ owner: { id: 3 } });
  });
});

describe('reset links last one hour (issues/384)', () => {
  beforeEach(() => jest.resetModules());

  it('resetLinkAlive', () => {
    const { resetLinkAlive } = require('../src/extensions/users-permissions/strapi-server');
    const now = Date.parse('2026-10-31T12:00:00Z');
    expect(resetLinkAlive(null, now)).toBe(false);
    expect(resetLinkAlive('2026-10-31T11:30:00Z', now)).toBe(true);
    expect(resetLinkAlive('2026-10-31T10:59:00Z', now)).toBe(false);
  });

  function plugin() {
    const calls = { reset: 0, forgot: 0 };
    const p = {
      controllers: {
        user: { create: jest.fn(), update: jest.fn() },
        auth: () => ({
          forgotPassword: async () => {
            calls.forgot += 1;
          },
          resetPassword: async () => {
            calls.reset += 1;
          },
          changePassword: jest.fn(),
          register: jest.fn(),
          callback: jest.fn(),
        }),
      },
      services: {},
      routes: {},
    };
    require('../src/extensions/users-permissions/strapi-server')(p);
    return { auth: p.controllers.auth({}), calls };
  }

  function stubUsers(owner) {
    const updates = [];
    const updateMany = jest.fn(async (args) => updates.push(args));
    global.strapi = {
      log: { warn: jest.fn() },
      db: {
        query: () => ({
          findOne: async ({ where }) => (where.resetPasswordToken ? owner : null),
          update: async (args) => updates.push(args),
          updateMany,
        }),
      },
    };
    return { updates, updateMany };
  }

  it('refuses and clears an expired or undated token', async () => {
    const { updates } = stubUsers({ id: 5, reset_password_requested_at: null });
    const { auth, calls } = plugin();
    const ctx = { request: { body: { code: 'abc', password: 'Una-Contrasenya-Llarga-9', passwordConfirmation: 'x' } } };
    await expect(auth.resetPassword(ctx)).rejects.toMatchObject({ name: 'ValidationError' });
    expect(calls.reset).toBe(0);
    expect(updates).toEqual([{ where: { id: 5 }, data: { resetPasswordToken: null } }]);
  });

  it('lets a fresh token through', async () => {
    stubUsers({ id: 5, reset_password_requested_at: new Date() });
    const { auth, calls } = plugin();
    const ctx = { request: { body: { code: 'abc', password: 'Una-Contrasenya-Llarga-9', passwordConfirmation: 'x' } } };
    await auth.resetPassword(ctx);
    expect(calls.reset).toBe(1);
  });

  it('dates the token when it is asked for, even if the mail fails', async () => {
    const { updateMany } = stubUsers(null);
    const { auth } = plugin();
    await auth.forgotPassword({ request: { body: { email: 'Admin@Coop.cat' } } });
    expect(updateMany).toHaveBeenCalledWith({
      where: { email: 'admin@coop.cat', resetPasswordToken: { $notNull: true } },
      data: { reset_password_requested_at: expect.any(Date) },
    });
  });
});

describe('clearPendingResetTokens (issues/384)', () => {
  it('clears every stored token', async () => {
    jest.resetModules();
    const chain = {
      whereNotNull: jest.fn(() => chain),
      update: jest.fn(async () => 3),
    };
    global.strapi = {
      log: { info: jest.fn() },
      db: { metadata: { get: () => ({ tableName: 'up_users' }) }, connection: jest.fn(() => chain) },
    };
    const { clearPendingResetTokens } = require('../src/services/clear-pending-reset-tokens');
    expect(await clearPendingResetTokens()).toBe(3);
    expect(chain.whereNotNull).toHaveBeenCalledWith('reset_password_token');
    expect(chain.update).toHaveBeenCalledWith({ reset_password_token: null });
  });
});
