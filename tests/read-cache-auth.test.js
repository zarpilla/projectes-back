'use strict';

/**
 * issues/307 — every authenticated request read the user and her role
 * (users-permissions fetchAuthenticatedUser: 2 queries) and her app
 * permissions (middlewares/app-permissions.js: 2 queries); measured locally, a
 * request answered from the read cache still ran 7 queries. Both are now kept
 * in the read cache per user. What must hold:
 *   - a second request of the same person doesn't reach the database;
 *   - a change of the user (blocked, role) or of her app permissions applies
 *     at her next request;
 *   - people are kept apart;
 *   - the user's secrets are never kept nor handed over in ctx.state.user;
 *   - a user that doesn't exist is not kept;
 *   - with the cache off, everything reads the database as before.
 */

const KEY_CACHE = Symbol.for('esstrapis.readCache.cache');
const { ChangeTracker } = require('../src/services/read-cache/change-tracker');
const { ReadCache } = require('../src/services/read-cache/read-cache');

const USER = 'plugin::users-permissions.user';
let tracker;
let cache;
let users;
let reads;

const sql = (statement) => tracker.statementEnded('c1', tracker.statementStarted('c1', statement));

beforeEach(() => {
  jest.resetModules();
  tracker = new ChangeTracker();
  tracker.setLogger({ warn: () => {} });
  tracker.setSchema({
    tables: [
      'users-permissions_user',
      'users_permissions_user_role_lnk',
      'up_roles',
      'users-permissions_user_cmps',
      'components_permissions_application_permissions',
    ],
  });
  cache = new ReadCache({ tracker });
  cache.enable();
  globalThis[KEY_CACHE] = cache;
  reads = 0;
  users = {
    1: {
      id: 1,
      username: 'anna',
      blocked: false,
      password: 'hash',
      resetPasswordToken: 't',
      role: { id: 1 },
      permissions: ['hours'],
    },
    2: { id: 2, username: 'pau', blocked: false, password: 'hash2', role: { id: 1 }, permissions: ['admin'] },
  };
  global.strapi = {
    db: {
      metadata: {
        get: (uid) => (uid === USER ? { tableName: 'users-permissions_user', attributes: {} } : null),
      },
      query: () => ({
        findOne: async ({ where, populate }) => {
          reads++;
          sql('select * from `users-permissions_user` where `id` = ?');
          const user = users[where.id];
          if (!user) return null;
          if (populate && populate.permissions) {
            sql(
              'select * from `components_permissions_application_permissions` join `users-permissions_user_cmps` on 1',
            );
            return { id: user.id, permissions: user.permissions.map((permission) => ({ permission })) };
          }
          sql('select * from `up_roles` join `users_permissions_user_role_lnk` on 1');
          const { permissions, ...row } = user;
          return structuredClone(row);
        },
      }),
    },
  };
});

afterEach(() => {
  delete globalThis[KEY_CACHE];
  delete global.strapi;
});

// the plugin's user service, as fetchAuthenticatedUser reads it
const userService = () =>
  require('../src/services/authenticated-user-cache').cacheAuthenticatedUser({
    fetchAuthenticatedUser: (id) =>
      global.strapi.db.query(USER).findOne({ where: { id }, populate: ['role'] }),
  });

describe('the authenticated user', () => {
  it('is read once, then kept, without her secrets', async () => {
    const service = userService();
    const first = await service.fetchAuthenticatedUser(1);
    const second = await service.fetchAuthenticatedUser(1);
    expect(reads).toBe(1);
    expect(second).toEqual({ id: 1, username: 'anna', blocked: false, role: { id: 1 } });
    expect(first).toEqual(second);
    expect(JSON.stringify([...cache.entries.values()].map((e) => e.value))).not.toMatch(
      /password|hash|resetPasswordToken/,
    );
  });

  it('blocking her applies at her next request', async () => {
    const service = userService();
    await service.fetchAuthenticatedUser(1);
    users[1].blocked = true;
    sql('update `users-permissions_user` set `blocked` = ? where `id` = ?');
    expect((await service.fetchAuthenticatedUser(1)).blocked).toBe(true);
  });

  it('a change of her role applies at her next request', async () => {
    const service = userService();
    await service.fetchAuthenticatedUser(1);
    users[1].role = { id: 3 };
    sql('update `users_permissions_user_role_lnk` set `role_id` = ? where `user_id` = ?');
    expect((await service.fetchAuthenticatedUser(1)).role).toEqual({ id: 3 });
  });

  it('people are kept apart, and a missing user is not kept', async () => {
    const service = userService();
    expect((await service.fetchAuthenticatedUser(1)).username).toBe('anna');
    expect((await service.fetchAuthenticatedUser(2)).username).toBe('pau');
    expect(await service.fetchAuthenticatedUser(9)).toBeNull();
    expect(await service.fetchAuthenticatedUser(9)).toBeNull();
    expect(reads).toBe(4);
  });

  it('a caller changing ctx.state.user does not change what is kept', async () => {
    const service = userService();
    const user = await service.fetchAuthenticatedUser(1);
    user.role.id = 99;
    expect((await service.fetchAuthenticatedUser(1)).role).toEqual({ id: 1 });
  });

  it('with the cache off it reads the database every time (secrets still out)', async () => {
    cache.disable();
    const service = userService();
    await service.fetchAuthenticatedUser(1);
    const user = await service.fetchAuthenticatedUser(1);
    expect(reads).toBe(2);
    expect(user.password).toBeUndefined();
  });
});

describe('the app permissions', () => {
  const service = () => require('../src/services/app-permissions');

  it('are read once per person, then kept', async () => {
    const { appPermissionsOf, isAppAdmin } = service();
    expect(await appPermissionsOf(1)).toEqual(['hours']);
    expect(await appPermissionsOf(1)).toEqual(['hours']);
    expect(await isAppAdmin(2)).toBe(true);
    expect(await isAppAdmin(1)).toBe(false);
    expect(reads).toBe(2);
  });

  it('a change of her permissions applies at her next request', async () => {
    const { appPermissionsOf } = service();
    await appPermissionsOf(1);
    users[1].permissions = ['hours', 'admin'];
    sql('insert into `components_permissions_application_permissions` (`permission`) values (?)');
    sql('insert into `users-permissions_user_cmps` (`entity_id`, `cmp_id`) values (?, ?)');
    expect(await appPermissionsOf(1)).toEqual(['hours', 'admin']);
  });

  it('no user, no permissions, nothing read', async () => {
    const { appPermissionsOf, hasAppPermission } = service();
    expect(await appPermissionsOf(undefined)).toEqual([]);
    expect(await hasAppPermission(null, 'admin')).toBe(false);
    expect(reads).toBe(0);
  });
});
