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

/**
 * issues/396 (security review round 3, 2026-11-01): the guard above needed
 * `owner` in the row. Member 51 asked for order 8972 (member 56's) with
 * `populate[emitted_invoice]=true` and no owner: she got its price (10.78) and
 * invoice 2025-157 (534.50 €, PDF path); `orders/totals?_where[id]=8972` gave
 * the price too. Now an order without its owner keeps its money only when it is
 * one of hers, and the figures of the list count only her own orders.
 */
describe('orders whose owner is not in the answer (issues/396)', () => {
  const noOwner = (id) => ({ ...order(null), id, owner: undefined });
  const rules = rulesFor({ member: true, selfId: ME, permissions: ['orders'], ownOrders: new Set([510]) });

  it('drops the money of an order that is not hers, at the root too', () => {
    const body = { data: [noOwner(8972), noOwner(510)] };
    sanitizeResponse(strapi, 'api::order.order', body, rules);
    const [other, own] = body.data;
    expect(other.price).toBeUndefined();
    expect(other.emitted_invoice).toBeUndefined();
    expect(other.units).toBe(3);
    expect(own.price).toBe(20);
    expect(own.emitted_invoice.code).toBe('2025-157');
  });

  it('a single row and a nested order the same way', () => {
    const one = { data: noOwner(8972) };
    sanitizeResponse(strapi, 'api::order.order', one, rules);
    expect(one.data.finalPrice).toBeUndefined();
    const nested = { data: [{ id: 1, order: noOwner(510) }] };
    sanitizeResponse(strapi, 'api::incidence.incidence', nested, rules);
    expect(nested.data[0].order.price).toBe(20);
  });

  it('without the list of her orders, nothing of unknown owner keeps its money', () => {
    const body = { data: [noOwner(510)] };
    sanitizeResponse(strapi, 'api::order.order', body, rulesFor({ member: true, selfId: ME, permissions: ['orders'] }));
    expect(body.data[0].price).toBeUndefined();
  });
});

describe('the figures of the member list (issues/396)', () => {
  it('totals, count and status tabs only over the orders she owns', async () => {
    jest.resetModules();
    const { MEMBER_SCOPES } = require('../src/middlewares/app-permissions');
    for (const action of ['totals', 'tableCount', 'tableStatusCounts']) {
      const ctx = { query: { _where: { id: 8972 } } };
      const next = jest.fn();
      await MEMBER_SCOPES[`api::order.order.${action}`](ctx, next, { strapi: {}, userId: ME });
      expect(next).toHaveBeenCalled();
      expect(JSON.stringify(ctx.query)).toContain(`"owner.id":${ME}`);
      expect(JSON.stringify(ctx.query)).not.toContain('contact.id_in');
    }
  });
});
