'use strict';

/**
 * issues/177 (2026-10-18): the figures above the orders list (Comandes) summed
 * only the page it had loaded (150 rows). On «Processades 175» it showed
 * 3.369,38 kg and 1.744,84 € for 3.934,58 kg and 2.053,46 €, and only the count
 * said «+». GET /orders/totals gives them over every order matching the list's
 * filters. issues/178: an order is refrigerated by its flag, in the list and in
 * the report alike.
 */
const path = require('path');

const ORDER = 'api::order.order';
const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'order', 'controllers', 'order.js');

afterEach(() => {
  delete global.strapi;
});

beforeEach(() => {
  jest.resetModules();
});

describe('orderTotals (issues/177)', () => {
  it('adds up every active order, the discounted price, and counts the cancelled apart', () => {
    const { orderTotals } = require('../src/api/order/services/order-totals');
    const rows = [
      { status: 'processed', units: 2, kilograms: '10.25', price: '20.00', volume_discount: '2.00', multidelivery_discount: '10.00', refrigerated: true, transfer: true, pickup: { id: 1, pickup: true }, deposit_date: '2026-10-07' },
      { status: 'processed', units: 1, kilograms: '3.10', price: '8.335', refrigerated: false, pickup: { id: 2, pickup: false } },
      { status: 'cancelled', units: 9, kilograms: '99', price: '99', refrigerated: true, transfer: true },
    ];
    expect(orderTotals(rows)).toEqual({
      active: 2,
      cancelled: 1,
      units: 3,
      kg: 13.35,
      // (20 − 2) × 0.9 = 16.20, plus 8.34
      price: 24.54,
      refrigerated: 1,
      transfers: 1,
      pickups: 1,
      deposited: 1,
    });
  });

  it('a collection order flagged refrigerated counts, whatever its delivery type (issues/178)', () => {
    const { orderTotals } = require('../src/api/order/services/order-totals');
    const rows = [{ status: 'pending', is_collection_order: true, refrigerated: 1, delivery_type: { name: 'Normal' } }];
    expect(orderTotals(rows).refrigerated).toBe(1);
  });
});

describe('GET /orders/totals (issues/177)', () => {
  it('reads every order matching the filters, without a page', async () => {
    const findMany = jest.fn(async () => [
      { status: 'processed', units: 3, kilograms: 4, price: 5 },
      { status: 'processed', units: 1, kilograms: 1, price: 1 },
    ]);
    global.strapi = { db: { query: jest.fn(() => ({ findMany })) }, contentType: () => ({ uid: ORDER, attributes: {} }) };
    const ctrl = require(CONTROLLER)({ strapi: global.strapi });

    const res = await ctrl.totals({ query: { _limit: '150', _start: '0', _where: { status: 'processed' } } });

    expect(global.strapi.db.query).toHaveBeenCalledWith(ORDER);
    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({ status: 'processed' });
    expect(args).not.toHaveProperty('limit');
    expect(args).not.toHaveProperty('offset');
    expect(args.select).toEqual(expect.arrayContaining(['units', 'kilograms', 'price', 'refrigerated']));
    expect(res).toMatchObject({ active: 2, units: 4, kg: 5, price: 6 });
  });

  it('is open to everyone in logistics, and members get their own orders only', () => {
    const { isAllowed } = require('../src/services/app-access-rules');
    const action = `${ORDER}.totals`;
    for (const p of ['orders', 'orders_admin', 'orders_delivery', 'projects']) expect(isAllowed(action, [p])).toBe(true);
    expect(isAllowed(action, ['hours'])).toBe(false);
    const { MEMBER_SCOPES } = require('../src/middlewares/app-permissions');
    expect(MEMBER_SCOPES[action]).toBe(MEMBER_SCOPES[`${ORDER}.find`]);
  });

  it('is granted to the authenticated role', () => {
    const text = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'services', 'bootstrap-permissions.js'), 'utf8');
    expect(text).toMatch(/'table',\s*'totals',/);
  });
});
