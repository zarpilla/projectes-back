'use strict';

/**
 * issues/401 (security review round 3, 2026-11-01): small leaks and limits.
 * - `GET /api/me` gave every user the entity's iCal URL and CCC;
 * - workers read everyone's planned hours in Informes › Dedicació;
 * - the labels PDF checked `Number(id)` but printed the raw ids;
 * - `orders/check-multidelivery` took another member's `ownerId`;
 * - members read `comments_internal` of received incomes and, through the
 *   `{ invoices }` wrapper of pending-provider, of emitted invoices;
 * - custom endpoints let a populated user's `reset_password_requested_at` through;
 * - someone with `orders` and `orders_delivery` had no invoice scope;
 * - uploads up to 1 GB; calendar imports over any range.
 */

describe('issues/401', () => {
  beforeEach(() => jest.resetModules());
  const perms = () => require('../src/middlewares/app-permissions');

  it("`me` without the entity's calendar URL and CCC", () => {
    const me = { name: 'Coop', ical: 'https://calendar.google.com/x/private-abc/basic.ics', ccc: '17/123', front_url: 'u' };
    perms().stripMe(me);
    expect(me).toEqual({ name: 'Coop', front_url: 'u' });
  });

  it("a worker's planned hours are her own", async () => {
    const ctx = {};
    await perms().OWN_SCOPES['api::project.project.findWithPhasesBoth'](
      ctx,
      async () => {
        ctx.body = [{ id: 1, activities: [], planned_hours: [{ user: 7, hours: 3 }, { user: 8, hours: 5 }, { user: { id: 7 }, hours: 1 }] }];
      },
      { userId: 7 },
    );
    expect(ctx.body[0].planned_hours).toEqual([{ user: 7, hours: 3 }, { user: { id: 7 }, hours: 1 }]);
  });

  it('the labels PDF prints the ids it checked', async () => {
    const strapi = { db: { query: () => ({ findMany: async () => [], findOne: async () => null }) } };
    const scope = perms().MEMBER_SCOPES['api::order.order.pdfmultiple'];
    await expect(scope({ request: { body: { orders: ['8972abc'] } } }, jest.fn(), { strapi, userId: 32 })).rejects.toMatchObject({ name: 'ValidationError' });
    const ctx = { request: { body: { orders: ['24900', 24899] } } };
    await scope(ctx, jest.fn(), { strapi, userId: 32 });
    expect(ctx.request.body.orders).toEqual([24900, 24899]);
  });

  it('the multidelivery check of a member is about herself', async () => {
    const ctx = { request: { body: { ownerId: 56, contactId: 3, date: '2026-11-24' } } };
    await perms().MEMBER_SCOPES['api::order.order.checkMultidelivery'](ctx, jest.fn(), { userId: 32 });
    expect(ctx.request.body.ownerId).toBe(32);
  });

  it("someone with orders who isn't a member nor the office gets her own invoices only", async () => {
    const { GENERAL_SCOPES } = perms();
    const strapi = { db: { query: () => ({ findMany: async () => [{ id: 4 }], findOne: async () => null }) } };
    const ctx = { query: {} };
    await GENERAL_SCOPES['api::emitted-invoice.emitted-invoice.findBasic'](ctx, jest.fn(), { strapi, userId: 9, permissions: ['orders', 'orders_delivery'] });
    expect(JSON.stringify(ctx.query)).toContain('contact.id_in');
    const office = { query: {} };
    await GENERAL_SCOPES['api::received-income.received-income.findBasic'](office, jest.fn(), { strapi, userId: 9, permissions: ['orders_admin', 'orders'] });
    expect(office.query).toEqual({});
  });

  it("members don't get the office's notes of received incomes nor through pending-provider", () => {
    const { sanitizeResponse, rulesFor } = require('../src/services/response-sanitizer');
    const strapi = { contentTypes: {}, components: {} };
    const rules = rulesFor({ member: true, selfId: 32, permissions: ['orders'] });
    const income = { data: [{ id: 1, total: 5, comments_internal: 'n' }] };
    sanitizeResponse(strapi, 'api::received-income.received-income', income, rules);
    expect(income.data[0]).toEqual({ id: 1, total: 5 });
    const pending = { invoices: [{ id: 2, comments_internal: 'n', total: 3 }] };
    sanitizeResponse(strapi, 'api::emitted-invoice.emitted-invoice', pending, rules);
    expect(pending.invoices[0]).toEqual({ id: 2, total: 3 });
  });

  it("no user's reset request date in API answers", () => {
    const { stripUserSecrets } = require('../src/middlewares/strip-user-secrets');
    const body = [{ id: 1, leader: { id: 2, username: 'x', reset_password_requested_at: '2026-10-31' } }];
    stripUserSecrets(body);
    expect(body[0].leader).toEqual({ id: 2, username: 'x' });
  });

  it('uploads are limited to 100 MB', () => {
    const config = require('../config/plugins.js')({ env: Object.assign((k, d) => d, { bool: (k, d) => d, int: (k, d) => d, array: (k, d) => d }) });
    expect(config.upload.config.sizeLimit).toBe(100 * 1024 * 1024);
  });
});
