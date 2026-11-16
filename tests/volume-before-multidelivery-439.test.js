'use strict';

/**
 * issues/439 (2026-11-16, La Diligència): with both the 2 € volume discount and
 * the 20 % multidelivery discount, the 2 € come off first and the 20 % applies
 * to what is left, in every place the price is worked out. Diligència 24679:
 * 12,07 € → 10,07 € → 8,06 €; invoice 886 has the line at base 10,07, 20 %.
 * Pinned so the order of the discounts doesn't change.
 */
const { orderDiscountedPrice, orderInvoiceLine } = require('../src/api/order/services/final-price');

describe('volume discount before multidelivery (issues/439)', () => {
  const o = { price: 12.07, volume_discount: 2, multidelivery_discount: 20 };

  it('the price takes the 2 € off first, then the 20 %', () => {
    expect(orderDiscountedPrice(o)).toBe(8.06);
  });

  it('the invoice line has the 2 € off its base and the 20 % as its discount', () => {
    expect(orderInvoiceLine(o)).toEqual({ base: 10.07, discount: 20 });
  });

  it('the SQL of the price filter has the same order', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'api', 'order', 'controllers', 'order.js'), 'utf8');
    expect(src).toMatch(/\(COALESCE\(price, 0\) - COALESCE\(volume_discount, 0\)\)/);
  });
});
