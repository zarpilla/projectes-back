'use strict';

/**
 * issues/145 (and 057), 2026-10-18: the discounted price of a logistics order
 * had three formulas. For a 10 € order with 1 € volume discount, 10 %
 * multidelivery and 5 % pickup discount:
 *   - the orders list finalPrice: price × (1 − md) × (1 − cp) − vol = 7,55
 *   - the stats infoAll:         (price − vol) × (1 − md) × (1 − cp) = 7,70
 *   - the invoice line:          (price − vol) × (1 − (md + cp))     = 7,65
 * The invoice's is kept (it is what members have been charged); the list and
 * the stats now use the same function, rounded to cents as the invoice line.
 */

const fs = require('fs');
const path = require('path');

const { computeLineTotals } = require('../src/services/document-lifecycle');
const finalPrice = require('../src/api/order/services/final-price');

const controller = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'api', 'order', 'controllers', 'order.js'),
  'utf8',
);

const EXAMPLE = { price: 10, volume_discount: 1, multidelivery_discount: 10, contact_pickup_discount: 5 };

// seeded PRNG, so a failure is reproducible
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function generatedOrders(n) {
  const rand = prng(145);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  return Array.from({ length: n }, () => ({
    price: Math.round(rand() * 4000) / 100,
    volume_discount: pick([0, 0, 0.5, 1, 1.25, 2]),
    multidelivery_discount: pick([0, 0, 5, 10, 15]),
    contact_pickup_discount: pick([0, 0, 5, 10, 12.5]),
  }));
}

describe('one discount formula for orders (issues/145)', () => {
  it("the list's finalPrice is the invoice's amount", () => {
    expect(finalPrice.applyFinalPrice({ ...EXAMPLE }).finalPrice).toBe(7.65);
  });

  it('the invoice line is (price − volume) with the sum of the percentages', () => {
    expect(finalPrice.orderInvoiceLine(EXAMPLE)).toEqual({ base: 9, discount: 15 });
  });

  it('finalPrice equals the base the invoice computes for its line, to the cent', () => {
    for (const order of generatedOrders(500)) {
      const line = { ...finalPrice.orderInvoiceLine(order), quantity: 1, vat: 21, irpf: 0 };
      expect(finalPrice.applyFinalPrice({ ...order }).finalPrice).toBe(computeLineTotals([line]).total_base);
    }
  });

  it('the stats and the invoice creation use the shared function', () => {
    const infoAll = controller.slice(controller.indexOf('async infoAll(ctx)'), controller.indexOf('async createCSV(ctx)'));
    expect(infoAll).toContain('price: orderDiscountedPrice(o)');
    expect(controller).toContain('...orderInvoiceLine(o)');
    expect(controller).not.toMatch(/discount:\s*\(o\.multidelivery_discount/);
  });
});
