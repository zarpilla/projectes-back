'use strict';

/**
 * issues/317 (2026-10-22): opening an invoice on ladili_test took ~17 s. Just
 * before it, «Facturar» had asked for every delivered order with populate=*
 * (8–9 s on the VPS, 1.3 s locally for 661 orders; production diligencia logs
 * show up to 10.8 s), and every request after it waited behind it.
 * Facturar only reads the amounts of each order, its member and the invoice it
 * is linked to: GET /orders/for-invoicing gives exactly that.
 *
 * Guards: the endpoint reads only delivered orders, with a narrow select and
 * populate (no populate=*), newest first; only orders_admin may call it.
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

describe('GET /orders/for-invoicing (issues/317)', () => {
  it('reads the delivered orders with only what Facturar needs', async () => {
    const rows = [{ id: 2, price: '10.00', owner: { id: 7, fullname: 'Ana' }, emitted_invoice: null }];
    const findMany = jest.fn(async () => rows);
    global.strapi = { db: { query: jest.fn(() => ({ findMany })) }, contentType: () => ({ uid: ORDER, attributes: {} }) };
    const ctrl = require(CONTROLLER)({ strapi: global.strapi });

    const result = await ctrl.forInvoicing({ query: {}, state: {} });

    expect(global.strapi.db.query).toHaveBeenCalledWith(ORDER);
    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({ status: 'delivered' });
    expect(args.select).toEqual(
      expect.arrayContaining([
        'id',
        'estimated_delivery_date',
        'price',
        'volume_discount',
        'late_order',
        'late_surcharge',
        'multidelivery_discount',
        'contact_pickup_discount',
        'units',
        'kilograms',
      ]),
    );
    expect(Object.keys(args.populate).sort()).toEqual(['emitted_invoice', 'owner']);
    expect(args.populate.owner.select).toEqual(expect.arrayContaining(['id', 'username', 'fullname']));
    expect(args.populate.emitted_invoice.select).toEqual(['id', 'state', 'code']);
    expect(args.orderBy).toEqual([{ route_date: 'desc' }, { id: 'desc' }]);
    expect(result).toBe(rows);
  });

  it('is open to orders_admin only, like invoicing them', () => {
    const { isAllowed } = require('../src/services/app-access-rules');
    expect(isAllowed('api::order.order.forInvoicing', ['orders_admin'])).toBe(true);
    expect(isAllowed('api::order.order.forInvoicing', ['orders'])).toBe(false);
    expect(isAllowed('api::order.order.forInvoicing', ['orders_delivery'])).toBe(false);
  });
});
