'use strict';

/**
 * issues/111 (2026-10-17): logistics invoice lines read «Comanda 2026-09-03 |
 * 23172 | DJ - BCN CIUTAT», the only ISO date on the invoice.
 */

const { orderLineConcept } = require('../src/api/order/services/invoice-line-concept');

describe('order invoice line concept (issues/111)', () => {
  it('writes the delivery date as DD/MM/YYYY', () => {
    expect(orderLineConcept({ id: 23172, estimated_delivery_date: '2026-09-03', route: { name: 'DJ - BCN CIUTAT' } }))
      .toBe('Comanda 03/09/2026 | 23172 | DJ - BCN CIUTAT');
  });

  it('pads short ids and leaves out what is missing', () => {
    expect(orderLineConcept({ id: 7, estimated_delivery_date: null, route: null }))
      .toBe('Comanda | 0007');
  });
});
