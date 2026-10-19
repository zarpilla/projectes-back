'use strict';

/**
 * issues/141 (2026-10-18): routes could only be created or switched off on the
 * server (Strapi admin); the API only let users read them. The logistics
 * office (`orders_admin`) now creates and edits them from «Rutes i punts»:
 * - `create`/`update`/`findOne` are granted to logged-in users, and the app
 *   permissions let only `orders_admin` (besides full access) write;
 * - routes are never deleted (old orders keep theirs): disabling one is
 *   `active = false`, so the router has no `delete`.
 */

const path = require('path');

const ME = 100;

function setup(permissions) {
  jest.resetModules();
  const strapi = {
    db: {
      query: jest.fn(() => ({
        findOne: jest.fn(async ({ where }) => ({
          id: where.id,
          permissions: permissions.map((permission) => ({ permission })),
        })),
      })),
    },
  };
  return require('../src/middlewares/app-permissions')({}, { strapi });
}

async function call(middleware, action, method = 'POST') {
  const ctx = {
    method,
    query: {},
    params: {},
    request: { body: { data: { name: 'Ruta nova', active: true } } },
    state: { user: { id: ME }, route: { handler: action, info: { apiName: 'route' } } },
  };
  const next = jest.fn(async () => {});
  await middleware(ctx, next);
  return next;
}

describe('who may write routes', () => {
  it.each([['orders_admin'], ['admin'], ['projects']])('%s creates and edits them', async (permission) => {
    const middleware = setup([permission]);
    expect(await call(middleware, 'api::route.route.create')).toHaveBeenCalled();
    expect(await call(middleware, 'api::route.route.update', 'PUT')).toHaveBeenCalled();
    expect(await call(middleware, 'api::route.route.findOne', 'GET')).toHaveBeenCalled();
  });

  it.each([['orders'], ['orders_delivery']])('%s only reads them', async (permission) => {
    const middleware = setup([permission]);
    expect(await call(middleware, 'api::route.route.find', 'GET')).toHaveBeenCalled();
    await expect(call(middleware, 'api::route.route.create')).rejects.toMatchObject({ name: 'ForbiddenError' });
    await expect(call(middleware, 'api::route.route.update', 'PUT')).rejects.toMatchObject({ name: 'ForbiddenError' });
  });

  // issues/188: no hours screen reads the routes (nor their volume discount price)
  it('hours does not even read them', async () => {
    const middleware = setup(['hours']);
    await expect(call(middleware, 'api::route.route.find', 'GET')).rejects.toMatchObject({ name: 'ForbiddenError' });
  });
});

describe('route API', () => {
  it('grants the actions to logged-in users (an ungranted action 403s before the app permissions)', () => {
    const matrix = require('fs').readFileSync(path.join(__dirname, '../src/services/bootstrap-permissions.js'), 'utf8');
    const line = matrix.split('\n').find((l) => l.trim().startsWith('route:'));
    for (const action of ['find', 'findOne', 'create', 'update']) expect(line).toContain(`'${action}'`);
    expect(line).not.toContain("'delete'");
  });

  it('has no delete: a route is disabled, never removed', () => {
    jest.resetModules();
    let opts;
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreRouter: (uid, o) => { opts = o; return {}; } } }));
    require('../src/api/route/routes/route');
    expect(opts.only).toEqual(['find', 'findOne', 'create', 'update']);
  });
});
