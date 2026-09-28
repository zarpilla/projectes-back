'use strict';

/**
 * The orders list showed "?" in the Preu column for every row.
 *
 * OrdersTable renders `props.row.finalPrice` and falls back to "?" when it is
 * falsy. finalPrice is not a column -- v3 computed it in an afterFind hook that
 * ran on EVERY query, so an order carried it however it was fetched. v5 has no
 * afterFind, and the port applied it only in find/findOne. The list actually
 * calls GET /api/orders/table, which returned rows straight from db.query.
 *
 * It also explains the stray discount dots in that column: they render on
 * `finalPrice !== price && volume_discount`, and `undefined !== price` is
 * always true.
 */

const fs = require('fs');
const path = require('path');

const { applyFinalPrice, applyFinalPriceToAll } = require('../src/api/order/services/final-price');

const SRC = path.join(__dirname, '..', 'src');
const controller = fs.readFileSync(
  path.join(SRC, 'api', 'order', 'controllers', 'order.js'),
  'utf8'
);

describe('finalPrice arithmetic', () => {
  it('is the plain price when there is no discount', () => {
    expect(applyFinalPrice({ price: 8.22 }).finalPrice).toBeCloseTo(8.22, 6);
  });

  it('applies the multidelivery discount as a percentage', () => {
    expect(applyFinalPrice({ price: 100, multidelivery_discount: 10 }).finalPrice)
      .toBeCloseTo(90, 6);
  });

  it('applies the pickup discount as a percentage', () => {
    expect(applyFinalPrice({ price: 100, contact_pickup_discount: 25 }).finalPrice)
      .toBeCloseTo(75, 6);
  });

  it('subtracts the volume discount as a fixed amount', () => {
    expect(applyFinalPrice({ price: 100, volume_discount: 12.5 }).finalPrice)
      .toBeCloseTo(87.5, 6);
  });

  it('compounds the percentages before subtracting the fixed amount', () => {
    // 100 * 0.9 * 0.5 = 45, then -5
    const order = {
      price: 100,
      multidelivery_discount: 10,
      contact_pickup_discount: 50,
      volume_discount: 5,
    };
    expect(applyFinalPrice(order).finalPrice).toBeCloseTo(40, 6);
  });

  it('treats a missing price as zero rather than NaN', () => {
    // NaN is falsy in the template, so it would render "?" just like undefined
    const result = applyFinalPrice({}).finalPrice;
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });

  it('sets the key even when the result is 0, not leaving it undefined', () => {
    expect('finalPrice' in applyFinalPrice({ price: 0 })).toBe(true);
  });

  it('tolerates null without throwing', () => {
    expect(() => applyFinalPrice(null)).not.toThrow();
  });
});

describe('applyFinalPriceToAll', () => {
  it('fills every row of a list', () => {
    const rows = applyFinalPriceToAll([{ price: 10 }, { price: 20, volume_discount: 5 }]);
    expect(rows.map((r) => r.finalPrice)).toEqual([10, 15]);
  });

  it('passes a non-array through untouched', () => {
    expect(applyFinalPriceToAll(undefined)).toBeUndefined();
  });
});

describe('the handlers that return order rows', () => {
  it('table applies it — the endpoint the orders list calls', () => {
    const start = controller.indexOf('async table(ctx)');
    const end = controller.indexOf('async infoAll(ctx)');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(controller.slice(start, end)).toContain('applyFinalPriceToAll(entities)');
  });

  it('find and findOne still apply it', () => {
    for (const name of ['async find(ctx)', 'async findOne(ctx)']) {
      const start = controller.indexOf(name);
      expect(start).toBeGreaterThan(-1);
      expect(controller.slice(start, start + 600)).toContain('applyFinalPrice(');
    }
  });

  it('uses the shared service rather than a local copy', () => {
    expect(controller).toContain("require('../services/final-price')");
    expect(controller).not.toMatch(/function applyFinalPrice\s*\(/);
  });
});
