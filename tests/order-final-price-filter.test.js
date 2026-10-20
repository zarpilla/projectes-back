'use strict';

/**
 * issues/276 (review 8, 2026-10-20): the Preu column filter of the orders list
 * sent `_where[price_contains]`, the rate's price before discounts (24885-R
 * shows 3,62 € and matched on 12,07), and a decimal comma matched nothing.
 * The list now sends `_where[final_price_contains]`, matched in SQL on the
 * price the column shows, with a comma or a point.
 */

const path = require('path');

const src = (...parts) => path.join(__dirname, '..', 'src', ...parts);

function load(ids = [24885]) {
  jest.resetModules();
  const whereRaw = jest.fn(async () => ids.map((id) => ({ id })));
  const findMany = jest.fn(async () => []);
  global.strapi = {
    db: {
      connection: jest.fn(() => ({ select: () => ({ whereRaw }) })),
      query: () => ({ findMany }),
    },
  };
  jest.doMock('@strapi/strapi', () => ({
    factories: { createCoreController: (_uid, cfg) => cfg({ strapi: global.strapi }) },
  }));
  const ctrl = require(src('api', 'order', 'controllers', 'order'));
  return { ctrl, whereRaw, findMany };
}

afterEach(() => {
  delete global.strapi;
  jest.dontMock('@strapi/strapi');
});

describe('orders Preu filter on the shown price (issues/276)', () => {
  it.each([
    ['3,62', '%3.62%'],
    ['3.62', '%3.62%'],
    [' 3,62 € ', '%3.62%'],
    ['1.234,5', '%1234.5%'],
    ['5%', '%5\\%%'],
  ])('matches %j as %j on the discounted price', async (typed, pattern) => {
    const { ctrl, whereRaw, findMany } = load();
    await ctrl.table({ query: { _where: { final_price_contains: typed, status: 'pending' } } });
    const [sql, bindings] = whereRaw.mock.calls[0];
    expect(sql).toMatch(/volume_discount.*multidelivery_discount.*contact_pickup_discount.*LIKE \?/);
    expect(bindings).toEqual([pattern]);
    const { where } = findMany.mock.calls[0][0];
    expect(JSON.stringify(where)).toContain('24885');
    expect(JSON.stringify(where)).not.toContain('final_price');
    expect(JSON.stringify(where)).toContain('pending');
  });

  it('finds nothing when no price matches, and the totals follow it', async () => {
    const { ctrl, findMany } = load([]);
    await ctrl.totals({ query: { _where: { final_price_contains: '999,99' } } });
    expect(JSON.stringify(findMany.mock.calls[0][0].where)).toMatch(/"id":\{"\$in":\[0\]\}/);
  });

  it('leaves other queries alone', async () => {
    const { ctrl, whereRaw } = load();
    await ctrl.table({ query: { _where: { status: 'pending' } } });
    expect(whereRaw).not.toHaveBeenCalled();
  });
});
