'use strict';

/**
 * issues/187 (2026-10-19): two ways a member still reached other members'
 * contacts after 165.
 * 1. `GET /contacts/for-orders` wasn't scoped: 1.273 contacts with NIF, phone,
 *    address, notes and pickup discount (`?owned=1` 1.162, `?socies=1` the 64
 *    member contacts with their collection points).
 * 2. `GET /contacts/96` (another member's) → 403, but `POST /orders` with
 *    `contact: 96` → 201, and from then on 96 was «a contact her orders go to»:
 *    readable in full and its address editable.
 */

const ME = 100;
const OTHER = 200;

const CONTACTS = {
  7: { id: 7, owner: null, users_permissions_user: { id: ME }, collection_points: [{ id: 30 }] },
  8: { id: 8, owner: { id: ME }, users_permissions_user: null },
  9: { id: 9, owner: { id: OTHER }, users_permissions_user: null, multiowner: true },
  30: { id: 30, owner: { id: OTHER }, users_permissions_user: null },
  31: { id: 31, owner: { id: OTHER }, users_permissions_user: null },
  96: { id: 96, owner: { id: OTHER }, users_permissions_user: null },
  97: { id: 97, owner: { id: OTHER }, users_permissions_user: null },
};
// the office created an order of hers to 97
const ORDERS = { 1: { id: 1, status: 'pending', owner: { id: ME }, contact: { id: 97 } } };

function makeStrapi() {
  const query = (uid) => ({
    findOne: jest.fn(async ({ where }) => {
      if (uid === 'plugin::users-permissions.user')
        return { id: where.id, permissions: [{ permission: 'orders' }] };
      if (uid === 'api::contact.contact') return CONTACTS[where.id] || null;
      if (uid === 'api::order.order') return ORDERS[where.id] || null;
      return null;
    }),
    findMany: jest.fn(async ({ where }) => {
      if (uid === 'api::order.order')
        return Object.values(ORDERS).filter((o) => o.owner.id === where.owner.id);
      if (uid !== 'api::contact.contact') return [];
      if (where.users_permissions_user) {
        return Object.values(CONTACTS).filter(
          (c) => c.users_permissions_user?.id === where.users_permissions_user.id,
        );
      }
      // the member's visibility clause
      const [owner, user, multiowner, , inIds] = where.$or;
      return Object.values(CONTACTS).filter(
        (c) =>
          c.owner?.id === owner.owner.id ||
          c.users_permissions_user?.id === user.users_permissions_user.id ||
          (c.multiowner === true) === multiowner.multiowner ||
          inIds.id.$in.includes(c.id),
      );
    }),
    count: jest.fn(async ({ where }) =>
      uid === 'api::order.order'
        ? Object.values(ORDERS).filter(
            (o) => o.owner.id === where.owner.id && o.contact.id === where.contact.id,
          ).length
        : 0,
    ),
  });
  return { db: { query: jest.fn(query) }, contentTypes: {}, components: {} };
}

let middleware;
beforeEach(() => {
  jest.resetModules();
  middleware = require('../src/middlewares/app-permissions')({}, { strapi: makeStrapi() });
});

function ctxFor(handler, { method = 'GET', query = {}, body, numericId, apiName = 'contact' } = {}) {
  return {
    method,
    query,
    params: {},
    request: { body },
    state: {
      user: { id: ME },
      route: { handler, info: { apiName } },
      v3: numericId !== undefined ? { numericId } : undefined,
    },
  };
}

async function run(ctx, answer) {
  const next = jest.fn(async () => {
    if (answer !== undefined) ctx.body = answer;
  });
  await middleware(ctx, next);
  return next;
}

const everyone = Object.values(CONTACTS).map((c) => ({
  id: c.id,
  users_permissions_user: c.users_permissions_user,
}));

describe('contacts/for-orders for a member (issues/187)', () => {
  it('lists only the points she sees: hers, the shared ones and the ones of her orders', async () => {
    const ctx = ctxFor('api::contact.contact.forOrders', { query: { owned: '1' } });
    await run(ctx, everyone);
    expect(ctx.body.map((c) => c.id).sort((a, b) => a - b)).toEqual([7, 8, 9, 97]);
  });

  it('gives her only her own contact from the members list (her collection points)', async () => {
    const ctx = ctxFor('api::contact.contact.forOrders', { query: { socies: '1' } });
    await run(ctx, everyone);
    expect(ctx.body.map((c) => c.id)).toEqual([7]);
  });
});

describe("the points of a member's order (issues/187)", () => {
  const create = (data) =>
    ctxFor('api::order.order.create', { method: 'POST', body: { data }, apiName: 'order' });

  it("refuses an order to another member's point", async () => {
    await expect(run(create({ contact: 96 }))).rejects.toMatchObject({ name: 'ForbiddenError' });
    await expect(run(create({ contact: { id: 96 } }))).rejects.toMatchObject({ name: 'ForbiddenError' });
  });

  it('accepts her points, the shared ones and the ones of her orders', async () => {
    for (const contact of [8, 9, 97]) expect(await run(create({ contact }))).toHaveBeenCalled();
  });

  it('accepts her collection points only', async () => {
    expect(await run(create({ collection_point: 30 }))).toHaveBeenCalled();
    await expect(run(create({ collection_point: 31 }))).rejects.toMatchObject({ name: 'ForbiddenError' });
  });

  it('refuses it on her order update and on the CSV import, and lets a new point through', async () => {
    const update = ctxFor('api::order.order.update', {
      method: 'PUT',
      numericId: 1,
      body: { data: { contact: 96 } },
      apiName: 'order',
    });
    await expect(run(update)).rejects.toMatchObject({ name: 'ForbiddenError' });
    const csv = (body) => ctxFor('api::order.order.createCSV', { method: 'POST', body, apiName: 'order' });
    await expect(run(csv({ contact: { id: 96 } }))).rejects.toMatchObject({ name: 'ForbiddenError' });
    expect(await run(csv({ contact: { name: 'Nou punt' } }))).toHaveBeenCalled();
  });
});

describe('a driver who is a member too (issues/187)', () => {
  it('keeps creating her own orders to any point: as a driver she sees them all', async () => {
    jest.resetModules();
    const strapi = makeStrapi();
    const findOne = strapi.db.query;
    strapi.db.query = jest.fn((uid) => {
      const q = findOne(uid);
      if (uid === 'plugin::users-permissions.user') {
        q.findOne = jest.fn(async ({ where }) => ({
          id: where.id,
          permissions: [{ permission: 'orders' }, { permission: 'orders_delivery' }],
        }));
      }
      return q;
    });
    middleware = require('../src/middlewares/app-permissions')({}, { strapi });
    const ctx = ctxFor('api::order.order.create', {
      method: 'POST',
      body: { data: { contact: 96 } },
      apiName: 'order',
    });
    expect(await run(ctx)).toHaveBeenCalled();
  });
});
