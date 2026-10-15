'use strict';

/**
 * issues/050 — users with payrolls could be deleted. The v3 guard was ported to
 * extensions/users-permissions/content-types/user/lifecycles.js, which Strapi 5
 * never loads (checked on a throwaway e2e database: db query, document service
 * and the plugin's remove() all deleted a user who had a payroll). Their payrolls
 * then pointed at nobody and the treasury forecast answered 500. The guard is now
 * subscribed from bootstrap() and refuses with a 400.
 */

function stubStrapi ({ users, counts }) {
  const subscribed = [];
  global.strapi = {
    db: {
      lifecycles: { subscribe: (s) => subscribed.push(s) },
      query: (uid) => ({
        findMany: async ({ where }) => users.filter((u) =>
          where.id === undefined ? true : (where.id.$in ? where.id.$in.includes(u.id) : where.id === u.id)),
        count: async ({ where }) => (counts[uid] || {})[where.users_permissions_user] || 0,
      }),
    },
  };
  return subscribed;
}

describe('user delete guard', () => {
  beforeEach(() => jest.resetModules());

  it('is subscribed for single and bulk deletes of users', () => {
    const subscribed = stubStrapi({ users: [], counts: {} });
    require('../src/services/user-delete-guard').registerUserDeleteGuard();
    expect(subscribed).toHaveLength(1);
    expect(subscribed[0].models).toEqual(['plugin::users-permissions.user']);
    expect(subscribed[0].beforeDelete).toBeInstanceOf(Function);
    expect(subscribed[0].beforeDeleteMany).toBeInstanceOf(Function);
  });

  it('refuses to delete a user who has payrolls', async () => {
    stubStrapi({ users: [{ id: 22, username: 'anna' }], counts: { 'api::payroll.payroll': { 22: 12 } } });
    const { guardUserDelete } = require('../src/services/user-delete-guard');
    const attempt = guardUserDelete({ params: { where: { id: 22 } } });
    // an ApplicationError: the API answers 400 with the message, not a 500
    await expect(attempt).rejects.toMatchObject({ name: 'ApplicationError' });
    await expect(guardUserDelete({ params: { where: { id: 22 } } })).rejects.toThrow('té 12 nòmines');
  });

  it('refuses a bulk delete if any of the users has hours or work periods', async () => {
    stubStrapi({
      users: [{ id: 1, username: 'pere' }, { id: 2, username: 'marta' }],
      counts: { 'api::daily-dedication.daily-dedication': { 2: 1 } },
    });
    const { guardUserDelete } = require('../src/services/user-delete-guard');
    await expect(guardUserDelete({ params: { where: { id: { $in: [1, 2] } } } })).rejects.toThrow('"marta": té 1 jornades');
  });

  it('lets a user without any of them be deleted', async () => {
    stubStrapi({ users: [{ id: 3, username: 'nou' }], counts: {} });
    const { guardUserDelete } = require('../src/services/user-delete-guard');
    await expect(guardUserDelete({ params: { where: { id: 3 } } })).resolves.toBeUndefined();
  });

  it('is registered in bootstrap()', () => {
    const index = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    expect(index).toMatch(/registerUserDeleteGuard\(\)/);
  });
});
