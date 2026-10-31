'use strict';

/**
 * issues/388 (security review round 2, 2026-10-31): a member reaches the
 * orders delivered to her own point, also those of other members, and orders
 * come with `populate=*`. On a copy of La Diligència member 51 (a pickup point)
 * got member 56's invoices 2025-157 and 2025-217 (totals and PDF path) through
 * `GET /api/orders`. Members also got the office's internal notes of invoices.
 *
 * Guards: of another member's order a member gets no invoice, price or
 * discounts; nested orders of unknown owner lose the invoice; invoices lose
 * `comments_internal`.
 */
const { sanitizeResponse, rulesFor } = require('../src/services/response-sanitizer');

const ME = 51;
const strapi = {
  contentTypes: {
    'api::order.order': {
      attributes: {
        owner: { type: 'relation', target: 'plugin::users-permissions.user' },
        emitted_invoice: { type: 'relation', target: 'api::emitted-invoice.emitted-invoice' },
      },
    },
    'api::incidence.incidence': { attributes: { order: { type: 'relation', target: 'api::order.order' } } },
    'api::emitted-invoice.emitted-invoice': { attributes: {} },
    'plugin::users-permissions.user': { attributes: {} },
  },
  components: {},
};
const invoice = { id: 9, code: '2025-157', total: 534.5, comments_internal: 'nota', pdf: '/uploads/documents/x.pdf' };
const order = (owner, extra = {}) => ({
  id: owner * 10,
  status: 'invoiced',
  units: 3,
  picked_up: false,
  price: 20,
  finalPrice: 18,
  volume_discount: 2,
  owner: owner === null ? undefined : { id: owner, username: `u${owner}` },
  emitted_invoice: { ...invoice },
  ...extra,
});

describe('a member and other members’ orders (issues/388)', () => {
  const rules = rulesFor({ member: true, selfId: ME, permissions: ['orders'] });

  it('drops the invoice, price and discounts of another member’s order', () => {
    const body = { data: [order(56), order(ME)] };
    sanitizeResponse(strapi, 'api::order.order', body, rules);
    const [other, own] = body.data;
    expect(other).toEqual({ id: 560, status: 'invoiced', units: 3, picked_up: false, owner: { id: 56, username: 'u56' } });
    expect(own.price).toBe(20);
    expect(own.emitted_invoice).toEqual({ id: 9, code: '2025-157', total: 534.5, pdf: '/uploads/documents/x.pdf' });
  });

  it('drops the invoice of a nested order whose owner is not in the answer', () => {
    const body = { data: [{ id: 1, order: { ...order(null), owner: undefined } }] };
    sanitizeResponse(strapi, 'api::incidence.incidence', body, rules);
    expect(body.data[0].order.emitted_invoice).toBeUndefined();
  });

  it('leaves the office alone', () => {
    const body = { data: [order(56)] };
    sanitizeResponse(strapi, 'api::order.order', body, rulesFor({ selfId: 27, permissions: ['orders_admin'] }));
    expect(body.data[0].emitted_invoice.comments_internal).toBe('nota');
    expect(body.data[0].price).toBe(20);
  });
});
