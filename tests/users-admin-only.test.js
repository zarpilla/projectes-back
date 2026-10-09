'use strict';

/**
 * Regression: issues/020 — any logged-in user could make themselves admin.
 *
 * The authenticated role is granted users-permissions `user.create` and
 * `user.update` (services/bootstrap-permissions.js) so #/admin/users works,
 * and the plugin's controllers don't restrict what a user sets on a user. A
 * worker with only the `hours` permission could PUT /api/users/<own id> with
 * permissions [admin]. Found by the front's e2e tests on 2026-10-09.
 *
 * The extension (src/extensions/users-permissions/strapi-server.js) lets only
 * users with the app `admin` permission create or update users.
 */

const path = require('path');

const EXTENSION = path.join(__dirname, '..', 'src', 'extensions', 'users-permissions', 'strapi-server.js');

function stubStrapi(usersById) {
  global.strapi = {
    db: {
      query: jest.fn(() => ({
        findOne: jest.fn(async ({ where }) => usersById[where.id] || null),
      })),
    },
  };
}

function plugin() {
  return {
    controllers: {
      user: {
        create: jest.fn(async (ctx) => { ctx.body = 'created'; }),
        update: jest.fn(async (ctx) => { ctx.body = 'updated'; }),
        find: jest.fn(),
      },
    },
  };
}

const ctxAs = (user) => ({ state: { user }, params: { id: '51' }, request: { body: {} } });

describe('users-permissions: only app admins create or update users (issues/020)', () => {
  beforeEach(() => {
    jest.resetModules();
    stubStrapi({
      1: { id: 1, permissions: [{ permission: 'projects' }, { permission: 'admin' }] },
      51: { id: 51, permissions: [{ permission: 'hours' }] },
    });
  });

  it('refuses a non-admin updating themselves (e.g. to add admin)', async () => {
    const unwrapped = plugin();
    const original = unwrapped.controllers.user.update;
    const p = require(EXTENSION)(unwrapped);
    await expect(p.controllers.user.update(ctxAs({ id: 51 }))).rejects.toMatchObject({ name: 'ForbiddenError' });
    expect(original).not.toHaveBeenCalled();
  });

  it('refuses a non-admin creating users', async () => {
    const p = require(EXTENSION)(plugin());
    await expect(p.controllers.user.create(ctxAs({ id: 51 }))).rejects.toMatchObject({ name: 'ForbiddenError' });
  });

  it('refuses requests without a user', async () => {
    const p = require(EXTENSION)(plugin());
    await expect(p.controllers.user.update(ctxAs(undefined))).rejects.toMatchObject({ name: 'ForbiddenError' });
  });

  it('lets admins create and update users', async () => {
    const p = require(EXTENSION)(plugin());
    const ctx = ctxAs({ id: 1 });
    await p.controllers.user.update(ctx);
    expect(ctx.body).toBe('updated');
    await p.controllers.user.create(ctx);
    expect(ctx.body).toBe('created');
  });

  it('leaves the other actions alone', async () => {
    const original = plugin();
    const find = original.controllers.user.find;
    const p = require(EXTENSION)(original);
    expect(p.controllers.user.find).toBe(find);
  });
});
