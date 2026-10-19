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
 * Decision (2026-10-19): as on master, members see and use every delivery
 * point (a contact with an owner); the rest of the directory (the entity's
 * clients, other members' own contacts) stays out.
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
  // the entity's client, and another member's own contact: not delivery points
  95: { id: 95, owner: null, users_permissions_user: null },
  94: { id: 94, owner: null, users_permissions_user: { id: OTHER } },
  // another member's own contact, with an owner (review 5: 1774)
  93: { id: 93, owner: { id: OTHER }, users_permissions_user: { id: OTHER } },
};
// orders of hers to 97 (another member's point) and to 95 (the office's client)
const ORDERS = {
  1: { id: 1, status: 'pending', owner: { id: ME }, contact: { id: 97 } },
  2: { id: 2, status: 'pending', owner: { id: ME }, contact: { id: 95 } },
};

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
          (inIds && inIds.id.$in.includes(c.id)),
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
  it('asks for the delivery points only, whichever list she calls', async () => {
    for (const query of [{}, { owned: '1' }]) {
      const ctx = ctxFor('api::contact.contact.forOrders', { query });
      await run(ctx, everyone);
      expect(ctx.query.owned).toBe('1');
    }
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

  it("refuses an order to a contact that isn't a delivery point", async () => {
    for (const contact of [95, 94, 93, { id: 95 }]) {
      await expect(run(create({ contact }))).rejects.toMatchObject({ name: 'ForbiddenError' });
    }
  });

  it("accepts any delivery point, another member's too, and her own contact", async () => {
    for (const contact of [7, 8, 9, 96, 97]) expect(await run(create({ contact }))).toHaveBeenCalled();
  });

  it('accepts her collection points only', async () => {
    expect(await run(create({ collection_point: 30 }))).toHaveBeenCalled();
    await expect(run(create({ collection_point: 31 }))).rejects.toMatchObject({ name: 'ForbiddenError' });
  });

  it('refuses it on her order update and on the CSV import, and lets a new point through', async () => {
    const update = ctxFor('api::order.order.update', {
      method: 'PUT',
      numericId: 1,
      body: { data: { contact: 95 } },
      apiName: 'order',
    });
    await expect(run(update)).rejects.toMatchObject({ name: 'ForbiddenError' });
    const csv = (body) => ctxFor('api::order.order.createCSV', { method: 'POST', body, apiName: 'order' });
    await expect(run(csv({ contact: { id: 95 } }))).rejects.toMatchObject({ name: 'ForbiddenError' });
    expect(await run(csv({ contact: { name: 'Nou punt' } }))).toHaveBeenCalled();
  });
});

// review 5: an order to a point made it «one her orders go to», readable in
// full and editable (contact 2242, 1774)
describe("an order doesn't make the point hers (issues/187)", () => {
  const row = (handler, method, body) => ctxFor(handler, { method, numericId: 97, body });

  it("doesn't let her read or edit another member's point her order goes to", async () => {
    await expect(run(row('api::contact.contact.findOne', 'GET'))).rejects.toMatchObject({
      name: 'ForbiddenError',
    });
    const update = row('api::contact.contact.update', 'PUT', { data: { time_slot_1_end: 19.5 } });
    await expect(run(update)).rejects.toMatchObject({ name: 'ForbiddenError' });
  });

  it('leaves it out of her contacts list', async () => {
    const ctx = ctxFor('api::contact.contact.find');
    await run(ctx);
    const clauses = ctx.query._where._and[0]._or;
    expect(clauses.some((c) => 'id_in' in c)).toBe(false);
  });

  it('still saves her order with the point it already has', async () => {
    const update = ctxFor('api::order.order.update', {
      method: 'PUT',
      numericId: 2,
      body: { data: { contact: 95, comments: 'x' } },
      apiName: 'order',
    });
    expect(await run(update)).toHaveBeenCalled();
  });
});

describe('a driver who is a member too (issues/187)', () => {
  it('keeps creating her own orders to any contact: as a driver she sees them all', async () => {
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
      body: { data: { contact: 95 } },
      apiName: 'order',
    });
    expect(await run(ctx)).toHaveBeenCalled();
  });
});

// issues/218 (review 5): a new contact with `users_permissions_user: 51`
// became member 51's own contact (her order form, `?socies=1`, invoicing).
describe('a new contact of a member (issues/218)', () => {
  it("doesn't link it to another user", async () => {
    const ctx = ctxFor('api::contact.contact.create', {
      method: 'POST',
      body: { data: { name: 'Nou', owner: ME, users_permissions_user: OTHER } },
    });
    await run(ctx);
    expect(ctx.request.body.data).toEqual({ name: 'Nou', owner: ME });
    const csv = ctxFor('api::order.order.createCSV', {
      method: 'POST',
      body: { contact: { name: 'Nou punt', users_permissions_user: { id: OTHER } } },
      apiName: 'order',
    });
    await run(csv);
    expect(csv.request.body.contact).toEqual({ name: 'Nou punt' });
  });

  it('keeps it when it names her', async () => {
    const ctx = ctxFor('api::contact.contact.create', {
      method: 'POST',
      body: { data: { name: 'Jo', users_permissions_user: ME } },
    });
    await run(ctx);
    expect(ctx.request.body.data).toEqual({ name: 'Jo', users_permissions_user: ME, owner: ME });
  });
});
