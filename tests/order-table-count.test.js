'use strict';

/**
 * issues/319 (2026-10-23): the orders list counted its total and each status
 * tab with `orders/count`, which the front emulates as a one-row core find,
 * and the backend gave every one of them populate=*. Seven per load of the
 * list: ~2,700 requests in three days on diligencia, median 1.5 s, up to 12 s.
 * GET /orders/table/count counts the rows /orders/table gives for the same
 * filters, without reading any row.
 *
 * The core find also ignored the Preu filter for the office (the tabs showed
 * every order) and refused it for a member (400), whose filters the scope
 * wraps in an `_and`.
 */

const path = require('path');

const src = (...parts) => path.join(__dirname, '..', 'src', ...parts);
const ORDER = 'api::order.order';

function load(ids = [24885]) {
  jest.resetModules();
  const whereRaw = jest.fn(async () => ids.map((id) => ({ id })));
  const count = jest.fn(async () => 42);
  const findMany = jest.fn(async () => []);
  const query = jest.fn(() => ({ count, findMany }));
  global.strapi = {
    db: { connection: jest.fn(() => ({ select: () => ({ whereRaw }) })), query },
  };
  jest.doMock('@strapi/strapi', () => ({
    factories: { createCoreController: (_uid, cfg) => cfg({ strapi: global.strapi }) },
  }));
  const ctrl = require(src('api', 'order', 'controllers', 'order'));
  return { ctrl, whereRaw, count, findMany, query };
}

afterEach(() => {
  delete global.strapi;
  jest.dontMock('@strapi/strapi');
});

describe('GET /orders/table/count (issues/319)', () => {
  it('counts with the filters of /orders/table, reading no row', async () => {
    const { ctrl, count, findMany, query } = load();
    const filters = { _where: { status: 'pending', 'route.id': '12', owner: '65' } };

    const n = await ctrl.tableCount({ query: JSON.parse(JSON.stringify(filters)) });
    await ctrl.table({ query: JSON.parse(JSON.stringify(filters)) });

    expect(n).toBe(42);
    expect(query).toHaveBeenCalledWith(ORDER);
    expect(Object.keys(count.mock.calls[0][0])).toEqual(['where']);
    expect(count.mock.calls[0][0].where).toEqual(findMany.mock.calls[0][0].where);
  });

  it('counts the Preu filter on the shown price, like the list', async () => {
    const { ctrl, whereRaw, count } = load([7, 9]);
    await ctrl.tableCount({ query: { _where: { final_price_contains: '12,5', status: 'delivered' } } });
    expect(whereRaw.mock.calls[0][1]).toEqual(['%12.5%']);
    const where = JSON.stringify(count.mock.calls[0][0].where);
    expect(where).toContain('[7,9]');
    expect(where).not.toContain('final_price');
  });

  it("translates the Preu filter inside a member's scope (_and)", async () => {
    const { ctrl, count, findMany } = load([5]);
    const scoped = () => ({
      _where: {
        _and: [
          { _or: [{ 'owner.id': 65 }, { 'contact.id_in': [67] }] },
          { owner: '65', final_price_contains: '3,62' },
        ],
      },
    });
    await ctrl.tableCount({ query: scoped() });
    await ctrl.totals({ query: scoped() });
    for (const where of [count.mock.calls[0][0].where, findMany.mock.calls[0][0].where]) {
      expect(JSON.stringify(where)).not.toContain('final_price');
      expect(JSON.stringify(where)).toMatch(/"id":\{"\$in":\[5\]\}/);
    }
  });

  it('gives every status tab in one request, each the filters AND its state (issues/324)', async () => {
    const { ctrl, count } = load();
    count.mockImplementation(async ({ where }) =>
      where.$and
        ? { pending: 3, processed: 2, delivered: 4, invoiced: 1, cancelled: 0 }[where.$and[1].status]
        : 10,
    );
    const counts = await ctrl.tableStatusCounts({ query: { _where: { 'route.id': '12', owner: '65' } } });

    expect(counts).toEqual({ all: 10, pending: 3, processed: 2, delivered: 4, invoiced: 1, cancelled: 0 });
    expect(count).toHaveBeenCalledTimes(6);
    const base = count.mock.calls[0][0].where;
    expect(JSON.stringify(base)).toContain('65');
    for (const [{ where }] of count.mock.calls.slice(1)) expect(where.$and[0]).toEqual(base);
  });

  it('is open to the logistics permissions, like the list', () => {
    jest.resetModules();
    const { isAllowed } = require('../src/services/app-access-rules');
    for (const action of ['tableCount', 'tableStatusCounts']) {
      for (const p of ['orders', 'orders_admin', 'orders_delivery']) {
        expect(isAllowed(`${ORDER}.${action}`, [p])).toBe(true);
      }
      expect(isAllowed(`${ORDER}.${action}`, ['hours'])).toBe(false);
    }
  });

  it('keeps a member to her own orders, like find', () => {
    jest.resetModules();
    const { MEMBER_SCOPES } = require('../src/middlewares/app-permissions');
    expect(MEMBER_SCOPES[`${ORDER}.tableCount`]).toBe(MEMBER_SCOPES[`${ORDER}.find`]);
    expect(MEMBER_SCOPES[`${ORDER}.tableStatusCounts`]).toBe(MEMBER_SCOPES[`${ORDER}.find`]);
  });
});
