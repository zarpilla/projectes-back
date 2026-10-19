'use strict';

/**
 * issues/186 (2026-10-19): ticket 163 cleared the price a member sends and let
 * the server compute it, but from whatever `route_rate` she sent. On a pending
 * refrigerated order of route 14 (rates 41 normal / 42 refrigerated) a member
 * PUT `route_rate: 37` (Girona Normal, another route) and paid 8,77 € instead
 * of 13,99 €; rate 41 (normal) 11,88 €; an empty rate 0,00 €. Same on create
 * and on the CSV import. The rate of a member's order is now the server's,
 * chosen the way the order form chooses it.
 */

const ME = 100;
const GIRONA = { id: 1, pickup: false };
const FINCA = { id: 2, pickup: true };
const NORMAL = 1;
const FRED = 2;

const RATES = [
  { id: 37, routes: [{ id: 9 }], pickup: null, delivery_type: { id: NORMAL } },
  { id: 41, routes: [{ id: 14 }], pickup: null, delivery_type: { id: NORMAL } },
  { id: 42, routes: [{ id: 14 }], pickup: null, delivery_type: { id: FRED } },
  { id: 43, routes: [], pickup: null, delivery_type: null },
  { id: 50, routes: [{ id: 14 }], pickup: FINCA, delivery_type: { id: NORMAL } },
];

const STORED = {
  24905: {
    id: 24905,
    status: 'pending',
    owner: { id: ME },
    contact: { id: 8 },
    route: { id: 14 },
    delivery_type: { id: FRED },
    pickup: { id: 1 },
    collection_point: null,
    route_rate: { id: 42 },
  },
  24906: {
    id: 24906,
    status: 'delivered',
    owner: { id: 300 },
    route: { id: 14 },
    delivery_type: { id: FRED },
    pickup: { id: 1 },
    route_rate: { id: 41 },
  },
};

function makeStrapi({ pendingFarmOrders = 0, permissions = ['orders'] } = {}) {
  const query = (uid) => ({
    findOne: jest.fn(async ({ where }) => {
      if (uid === 'plugin::users-permissions.user') {
        return { id: where.id, permissions: permissions.map((permission) => ({ permission })) };
      }
      if (uid === 'api::order.order') return STORED[where.id] || null;
      if (uid === 'api::pickup.pickup') return [GIRONA, FINCA].find((p) => p.id === where.id) || null;
      if (uid === 'api::contact.contact') return { id: where.id, pickup_discount: 0 };
      return null;
    }),
    findMany: jest.fn(async () => (uid === 'api::route-rate.route-rate' ? RATES : [])),
    count: jest.fn(async () => (uid === 'api::order.order' ? pendingFarmOrders : 0)),
  });
  return { db: { query: jest.fn(query) }, contentTypes: {}, components: {} };
}

function ctxFor(handler, { method, body, numericId }) {
  return {
    method,
    query: {},
    params: {},
    request: { body },
    state: {
      user: { id: ME },
      route: { handler, info: { apiName: 'order' } },
      v3: numericId !== undefined ? { numericId } : undefined,
    },
  };
}

async function send(handler, opts, strapiOptions = {}) {
  jest.resetModules();
  const strapi = makeStrapi(strapiOptions);
  const middleware = require('../src/middlewares/app-permissions')({}, { strapi });
  const ctx = ctxFor(handler, opts);
  const next = jest.fn();
  await middleware(ctx, next);
  expect(next).toHaveBeenCalled();
  return ctx.request.body;
}

const put = (data) => send('api::order.order.update', { method: 'PUT', numericId: 24905, body: { data } });

describe("a member's order gets the server's route rate (issues/186)", () => {
  it('ignores the rate of another route', async () => {
    expect((await put({ route_rate: 37 })).data).toMatchObject({ route_rate: 42, price: null });
  });

  it('ignores the normal rate on a refrigerated order, and an empty rate', async () => {
    expect((await put({ route_rate: 41 })).data.route_rate).toBe(42);
    expect((await put({ route_rate: 43 })).data.route_rate).toBe(42);
  });

  it('follows what she changes: the normal rate once the order is no longer refrigerated', async () => {
    expect((await put({ delivery_type: NORMAL, route_rate: 42 })).data.route_rate).toBe(41);
  });

  it('chooses the rate on create', async () => {
    const body = await send('api::order.order.create', {
      method: 'POST',
      body: { data: { route: 14, delivery_type: FRED, pickup: 1, route_rate: 37, kilograms: 14.5 } },
    });
    expect(body.data).toMatchObject({ route_rate: 42, price: null, owner: ME, status: 'pending' });
  });

  it('chooses the rate on the CSV import, as the `{ id }` createCSV reads', async () => {
    const body = await send('api::order.order.createCSV', {
      method: 'POST',
      body: { route: { id: 14 }, delivery_type: { id: NORMAL }, pickup: { id: 1 }, route_rate: { id: 43 } },
    });
    expect(body.route_rate).toEqual({ id: 41 });
  });

  it("gives a farm pickup the farm's rate, unless she already has one pending on the route", async () => {
    const data = { route: 14, delivery_type: NORMAL, pickup: 2, route_rate: 41 };
    const first = await send('api::order.order.create', { method: 'POST', body: { data: { ...data } } });
    expect(first.data.route_rate).toBe(50);
    const second = await send(
      'api::order.order.create',
      { method: 'POST', body: { data: { ...data } } },
      { pendingFarmOrders: 1 },
    );
    expect(second.data.route_rate).toBe(41);
  });

  it('leaves the rate alone when nothing it depends on changes', async () => {
    expect((await put({ comments: 'x' })).data).toEqual({ comments: 'x' });
  });
});

describe('pickOrderRouteRate (issues/186)', () => {
  const { pickOrderRouteRate } = require('../src/api/order/services/route-price');

  it('finds no rate without a route that has one', () => {
    expect(
      pickOrderRouteRate(
        RATES.filter((r) => r.id !== 43),
        { route: 99, delivery_type: NORMAL },
      ),
    ).toBeNull();
  });

  it('a collection point takes the warehouse rates even for a farm pickup', () => {
    const rate = pickOrderRouteRate(
      RATES,
      { route: 14, delivery_type: NORMAL, pickup: 2, collection_point: 5 },
      { pickup: FINCA },
    );
    expect(rate.id).toBe(41);
  });
});

// The user's decision (2026-10-19): the office's orders get the same rate,
// whoever writes them from the app (most office users also have `projects`).
describe("the office's orders get the server's route rate too (issues/186)", () => {
  const OFFICE = { permissions: ['hours', 'orders_admin', 'projects'] };
  const officePut = (numericId, data, options = OFFICE) =>
    send('api::order.order.update', { method: 'PUT', numericId, body: { data } }, options);

  it.each([[OFFICE], [{ permissions: ['orders_admin'] }]])(
    'replaces a wrong rate and leaves the price to the server (%j)',
    async (options) => {
      const body = await officePut(24905, { route_rate: 37, price: 8.77, kilograms: 14.5 }, options);
      expect(body.data).toMatchObject({ route_rate: 42, price: null, kilograms: 14.5 });
    },
  );

  it('keeps the price she sends with the right rate', async () => {
    const body = await officePut(24905, { route_rate: { id: 42 }, price: 13.99, kilograms: 14.5 });
    expect(body.data).toEqual({ route_rate: { id: 42 }, price: 13.99, kilograms: 14.5 });
  });

  it('leaves delivered orders and the writes without rate inputs alone', async () => {
    expect((await officePut(24906, { route_rate: 37, price: 1 })).data).toEqual({ route_rate: 37, price: 1 });
    expect((await officePut(24905, { comments: 'x', price: 2 })).data).toEqual({ comments: 'x', price: 2 });
  });

  it('chooses it on create and on the CSV import, for the owner of the order', async () => {
    const created = await send(
      'api::order.order.create',
      {
        method: 'POST',
        body: {
          data: { owner: 300, route: 14, delivery_type: FRED, pickup: 1, route_rate: 41, price: 11.88 },
        },
      },
      OFFICE,
    );
    expect(created.data).toMatchObject({ route_rate: 42, price: null, owner: 300 });
    const csv = await send(
      'api::order.order.createCSV',
      {
        method: 'POST',
        body: { owner: { id: 300 }, route: { id: 14 }, delivery_type: { id: NORMAL }, pickup: { id: 1 } },
      },
      OFFICE,
    );
    expect(csv).toMatchObject({ route_rate: { id: 41 }, price: null });
  });

  it('leaves collection orders alone', async () => {
    const body = await send(
      'api::order.order.create',
      { method: 'POST', body: { data: { is_collection_order: true, route: 14, route_rate: 37 } } },
      OFFICE,
    );
    expect(body.data.route_rate).toBe(37);
  });
});
