'use strict';

/**
 * issues/394 (security review round 2, 2026-10-31): for orders from the app
 * the server only checked "from tomorrow", not that the route runs that
 * weekday, is open (no closure in «Rutes i dies») and active; the integrations
 * API checks it. Members' orders are now checked the same way (create, CSV,
 * and a change of day or route); the office keeps its hand free.
 */
const ME = 32;
// 2026-11-02 is a Monday, 2026-11-03 a Tuesday
const ROUTE = { id: 25, name: 'DT - MARESME', monday: true, wednesday: true, active: true };

function setup({ permissions = ['orders'], route = ROUTE, closures = [] } = {}) {
  jest.resetModules();
  const strapi = {
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where }) => {
          if (uid === 'plugin::users-permissions.user') return { id: where.id, permissions: permissions.map((p) => ({ permission: p })) };
          if (uid === 'api::route.route') return route;
          return null;
        }),
        findMany: jest.fn(async () => (uid === 'api::route-festive.route-festive' ? closures : [])),
        count: jest.fn(async () => 0),
      })),
    },
    contentTypes: {},
    components: {},
  };
  global.strapi = strapi;
  return require('../src/middlewares/app-permissions')({}, { strapi });
}

async function create(middleware, date) {
  const ctx = {
    method: 'POST',
    query: {},
    params: {},
    request: { body: { data: { route: 25, contact: 7, estimated_delivery_date: date, units: 1 } } },
    state: { user: { id: ME }, route: { handler: 'api::order.order.create', info: { apiName: 'order' } } },
  };
  const next = jest.fn();
  await middleware(ctx, next);
  return next;
}

describe("a member's order day and route (issues/394)", () => {
  it('goes through on a day the route runs', async () => {
    expect(await create(setup(), '2026-11-02')).toHaveBeenCalled();
  });

  it('is refused on a day the route doesn’t run, naming the next one', async () => {
    await expect(create(setup(), '2026-11-03')).rejects.toMatchObject({
      name: 'ValidationError',
      message: expect.stringMatching(/no surt el dimarts 3\/11\/2026: el proper dia és el dimecres 4\/11\/2026/),
    });
  });

  it('is refused on a closed day or an inactive route', async () => {
    await expect(create(setup({ closures: [{ date: '2026-11-02', route: { id: 25 } }] }), '2026-11-02')).rejects.toMatchObject({
      message: expect.stringMatching(/està tancada/),
    });
    await expect(create(setup({ route: { ...ROUTE, active: false } }), '2026-11-02')).rejects.toMatchObject({
      message: expect.stringMatching(/no està activa/),
    });
  });

  it('leaves the office its special days', async () => {
    expect(await create(setup({ permissions: ['orders_admin'] }), '2026-11-03')).toHaveBeenCalled();
  });
});
