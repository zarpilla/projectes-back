'use strict';

/**
 * issues/403 (security review round 3, 2026-11-01), on a copy of La Diligència:
 * - member 32 created an order with `incidences: [138]` (and `[{ id: 137 }]`):
 *   other members' incidences moved to her new order (update only touches the
 *   order's own, issues/390);
 * - on her processed order 24899, priced 99.99 by the office, she PUT
 *   `lines: [{ units: 5, … }]`: the line was stored and the price went back to
 *   16.43. Once the office has the order she only ticks what was picked up.
 */

const ME = 100;

const STORED = {
  1: { id: 1, status: 'processed', owner: { id: ME }, contact: { id: 8 }, route: { id: 14 }, lines: [{ id: 5, units: 2, kilograms: 3, name: 'A', nif: 'N', picked_up: false }] },
  2: { id: 2, status: 'invoiced', owner: { id: ME }, contact: { id: 8 }, route: { id: 14 }, lines: [{ id: 6, units: 1, name: 'B', picked_up: false }] },
  3: { id: 3, status: 'pending', owner: { id: ME }, contact: { id: 8 }, route: { id: 14 }, delivery_type: { id: 1 }, lines: [] },
};

function makeStrapi(permissions = ['orders']) {
  const query = (uid) => ({
    findOne: jest.fn(async ({ where }) => {
      if (uid === 'plugin::users-permissions.user') {
        return { id: where.id, permissions: permissions.map((permission) => ({ permission })) };
      }
      if (uid === 'api::order.order') return STORED[where.id] ? structuredClone(STORED[where.id]) : null;
      if (uid === 'api::contact.contact') return { id: where.id, pickup_discount: 0, users_permissions_user: { id: ME } };
      return null;
    }),
    findMany: jest.fn(async () => []),
    count: jest.fn(async () => 0),
  });
  return { db: { query: jest.fn(query) }, contentTypes: {}, components: {} };
}

async function send(handler, { method, body, numericId }, permissions) {
  jest.resetModules();
  const middleware = require('../src/middlewares/app-permissions')({}, { strapi: makeStrapi(permissions) });
  const ctx = {
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
  const next = jest.fn();
  await middleware(ctx, next).catch((e) => {
    // the create scopes look further (contacts, route days) than these stubs answer
    if (!/ruta|Forbidden|contact/i.test(String(e && e.message))) throw e;
  });
  return ctx.request.body;
}

describe('no incidences on a new order (issues/403)', () => {
  it.each([
    ['member create', 'api::order.order.create', { data: { incidences: [138], route: 14 } }, ['orders']],
    ['member csv', 'api::order.order.createCSV', { incidences: [{ id: 137 }] }, ['orders']],
    ['office create', 'api::order.order.create', { data: { incidences: [138] } }, ['orders_admin']],
  ])('%s', async (_label, handler, body, permissions) => {
    const sent = await send(handler, { method: 'POST', body }, permissions);
    expect((sent.data || sent).incidences).toBeUndefined();
  });
});

describe("a member's processed order (issues/403)", () => {
  const put = (numericId, data) => send('api::order.order.update', { method: 'PUT', numericId, body: { data } });

  it('takes only the picked-up ticks of the lines, and no new price', async () => {
    const sent = await put(1, { lines: [{ id: 5, units: 500, name: 'x', picked_up: true }, { units: 9 }], price: 1 });
    expect(sent.data.lines).toEqual([{ id: 5, units: 2, kilograms: 3, name: 'A', nif: 'N', picked_up: true }]);
    expect('price' in sent.data).toBe(false);
    expect(sent.data.route_rate).toBeUndefined();
  });

  it('an invoiced order keeps its lines', async () => {
    const sent = await put(2, { lines: [], deposit_date: null });
    expect('lines' in sent.data).toBe(false);
  });

  it('a pending order is still hers to change and is repriced', async () => {
    const sent = await put(3, { lines: [{ units: 4, name: 'nou' }] });
    expect(sent.data.lines).toEqual([{ units: 4, name: 'nou' }]);
    expect(sent.data.price).toBeNull();
  });
});
