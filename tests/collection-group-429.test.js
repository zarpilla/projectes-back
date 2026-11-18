'use strict';

/**
 * issues/429 (Joel, la Diligència, 2026-11-10): grouped pickups (XXXXX-R).
 * Moving the -R (day or route) moves the pickup of every order it collects;
 * a pickup never comes after its order's delivery: a block move that would do
 * so is refused whole, naming the orders; an order's own edit is refused alike.
 */

const fs = require('fs');
const path = require('path');

function fakeDb({ orders = [], current = null } = {}) {
  const updates = [];
  global.strapi = {
    db: {
      query: () => ({
        findMany: async ({ where }) =>
          orders.filter((o) => o.collection_order === where.collection_order && !where.status.$notIn.includes(o.status)),
        findOne: async () => current,
        update: async ({ where, data }) => {
          updates.push({ id: where.id, data });
          return { id: where.id, ...data };
        },
      }),
    },
  };
  return { updates };
}

const load = () => require('../src/api/order/services/collection-group');

afterEach(() => {
  delete global.strapi;
  jest.resetModules();
});

const R = 900;
const child = (id, delivery, extra = {}) => ({
  id, collection_order: R, status: 'pending', estimated_delivery_date: delivery,
  collection_pickup_date: '2026-11-10', collection_pickup_route: { id: 3 }, ...extra,
});
const STORED_R = { id: R, is_collection_order: true, estimated_delivery_date: '2026-11-10', collection_pickup_date: '2026-11-10' };

describe('moving a -R (issues/429)', () => {
  it('is refused whole when an order would be delivered before its pickup, naming it', async () => {
    fakeDb({ orders: [child(1, '2026-11-14'), child(2, '2026-11-11'), child(3, '2026-11-11', { status: 'delivered' })] });
    const { pickupOrderRefusal } = load();
    const res = await pickupOrderRefusal(R, { estimated_delivery_date: '2026-11-12' }, STORED_R);
    expect(res.details).toEqual({ orders: [2] });
    expect(res.message).toMatch(/al 12\/11\/2026: la comanda 2 \(entrega 11\/11\/2026\) s'entrega abans/);
  });

  it('is allowed up to the delivery day, and when the day does not change', async () => {
    fakeDb({ orders: [child(1, '2026-11-14'), child(2, '2026-11-12')] });
    const { pickupOrderRefusal } = load();
    expect(await pickupOrderRefusal(R, { estimated_delivery_date: '2026-11-12' }, STORED_R)).toBeNull();
    expect(await pickupOrderRefusal(R, { estimated_delivery_date: '2026-11-10', route: 4 }, STORED_R)).toBeNull();
  });

  it('reads the moved day from either of its two dates (the form sends both)', async () => {
    fakeDb({ orders: [child(2, '2026-11-11')] });
    const { pickupOrderRefusal } = load();
    const res = await pickupOrderRefusal(R, { estimated_delivery_date: '2026-11-10', collection_pickup_date: '2026-11-13' }, STORED_R);
    expect(res.details.orders).toEqual([2]);
  });

  it('moves the pickup day and route of its open orders, and only theirs', async () => {
    const { updates } = fakeDb({
      orders: [child(1, '2026-11-14'), child(2, '2026-11-12', { collection_pickup_date: '2026-11-12' }), child(3, '2026-11-14', { status: 'cancelled' })],
      current: { id: R, is_collection_order: true, estimated_delivery_date: '2026-11-12', collection_pickup_date: '2026-11-12', route: { id: 4 } },
    });
    const { followCollectionMove } = load();
    const moved = await followCollectionMove(R, { ...STORED_R, route: { id: 3 } });
    expect(moved).toBe(2);
    expect(updates).toEqual([
      { id: 1, data: { collection_pickup_date: '2026-11-12', collection_pickup_route: 4, _internal: true } },
      { id: 2, data: { collection_pickup_route: 4, _internal: true } },
    ]);
  });

  it('touches nothing when the -R did not move', async () => {
    const { updates } = fakeDb({
      orders: [child(1, '2026-11-14')],
      current: { ...STORED_R, route: { id: 3 } },
    });
    expect(await load().followCollectionMove(R, { ...STORED_R, route: { id: 3 } })).toBe(0);
    expect(updates).toEqual([]);
  });

  it('keeps its two days together', () => {
    const { alignCollectionDays } = load();
    const quick = { estimated_delivery_date: '2026-11-12' };
    alignCollectionDays(quick, STORED_R);
    expect(quick).toEqual({ estimated_delivery_date: '2026-11-12', collection_pickup_date: '2026-11-12' });
    const form = { estimated_delivery_date: '2026-11-10', collection_pickup_date: '2026-11-13' };
    alignCollectionDays(form, STORED_R);
    expect(form).toEqual({ estimated_delivery_date: '2026-11-13', collection_pickup_date: '2026-11-13' });
    const normal = { estimated_delivery_date: '2026-11-12' };
    alignCollectionDays(normal, { ...STORED_R, is_collection_order: false });
    expect(normal).toEqual({ estimated_delivery_date: '2026-11-12' });
  });
});

describe('an order of the group by itself (issues/429)', () => {
  const STORED = { id: 7, is_collection_order: false, estimated_delivery_date: '2026-11-12', collection_pickup_date: '2026-11-10', collection_point: { id: 40 } };

  it('can not have its pickup after its delivery', async () => {
    fakeDb();
    const { pickupOrderRefusal } = load();
    const late = await pickupOrderRefusal(7, { collection_pickup_date: '2026-11-13' }, STORED);
    expect(late).toMatchObject({ details: { orders: [7] } });
    expect(late.message).toMatch(/recollida \(13\/11\/2026\) seria després de l'entrega \(12\/11\/2026\)/);
    expect(await pickupOrderRefusal(7, { estimated_delivery_date: '2026-11-09' }, STORED)).toMatchObject({ details: { orders: [7] } });
    expect(await pickupOrderRefusal(7, { collection_pickup_date: '2026-11-12' }, STORED)).toBeNull();
  });

  it('an order without farm pickup is not checked', async () => {
    fakeDb();
    const { pickupOrderRefusal } = load();
    expect(await pickupOrderRefusal(7, { estimated_delivery_date: '2026-11-01' }, { ...STORED, collection_point: null, collection_pickup_date: null })).toBeNull();
  });

  it('a new order neither', () => {
    const { newOrderPickupRefusal } = load();
    expect(newOrderPickupRefusal({ collection_point: 40, collection_pickup_date: '2026-11-13', estimated_delivery_date: '2026-11-12' }).message).toMatch(/després de l'entrega/);
    expect(newOrderPickupRefusal({ collection_point: 40, collection_pickup_date: '2026-11-12', estimated_delivery_date: '2026-11-12' })).toBeNull();
  });
});

describe('wiring (issues/429)', () => {
  it('the controller refuses before saving, with the order ids', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/api/order/controllers/order.js'), 'utf8');
    const update = source.slice(source.indexOf('async update(ctx)'));
    const at = update.indexOf('pickupOrderRefusal(numericId(ctx), payload, current)');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(update.indexOf('super.update(ctx)'));
    expect(update).toContain('ctx.badRequest(pickupAfter.message, pickupAfter.details)');
    const create = source.slice(source.indexOf('async create(ctx)'), source.indexOf('async update(ctx)'));
    expect(create.indexOf('newOrderPickupRefusal(payload)')).toBeLessThan(create.indexOf('super.create(ctx)'));
  });

  it('the -R moves its orders after it is saved', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/api/order/content-types/order/lifecycles.js'), 'utf8');
    expect(source).toContain('alignCollectionDays(data, previousOrder);');
    expect(source).toContain('await followCollectionMove(params.id, previousOrder);');
  });
});
