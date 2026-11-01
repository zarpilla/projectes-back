'use strict';

/**
 * issues/386 (security review round 2, 2026-10-31): the permissions middleware
 * scopes a member's or a worker's list by assigning ctx.query. Strapi
 * re-serialises it and parses it back with qs, which keeps only the first
 * 1,000 parameters: with ~1,000 junk parameters in the request the scope (added
 * last) was cut off, and a member got all 24,130 orders, a worker everyone's
 * 40,584 hours.
 *
 * Guards: limited users can't send more than 300 parameters, and a scope that
 * didn't survive the round trip is refused.
 */
const qs = require('qs');

const ME = 100;

function setup(permissions) {
  jest.resetModules();
  const strapi = {
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where }) => ({ id: where.id, permissions: permissions.map((p) => ({ permission: p })) })),
        findMany: jest.fn(async () => (uid === 'api::contact.contact' ? [{ id: 7 }] : [])),
      })),
    },
    contentTypes: {},
    components: {},
  };
  return require('../src/middlewares/app-permissions')({}, { strapi });
}

/** A ctx whose query behaves like Strapi's (strapi::query): qs both ways, with a parameter limit. */
function strapiCtx(handler, querystring, parameterLimit = 1000) {
  const ctx = {
    method: 'GET',
    querystring,
    params: {},
    request: {},
    state: { user: { id: ME }, route: { handler, info: { apiName: handler.split('::')[1].split('.')[0] } } },
  };
  Object.defineProperty(ctx, 'query', {
    get() {
      return qs.parse(this.querystring, { strictNullHandling: true, arrayLimit: 100, depth: 20, parameterLimit });
    },
    set(obj) {
      this.querystring = qs.stringify(obj);
    },
  });
  return ctx;
}

const junk = (n) => Array.from({ length: n }, () => '_start').join('&');

describe('scopes and the query parameter limit (issues/386)', () => {
  it('refuses a member request with too many parameters', async () => {
    const middleware = setup(['orders']);
    const ctx = strapiCtx('api::order.order.find', `pagination[pageSize]=1&${junk(998)}`);
    await expect(middleware(ctx, jest.fn())).rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('refuses a worker request with too many parameters', async () => {
    const middleware = setup(['hours']);
    const ctx = strapiCtx('api::workday-log.workday-log.find', junk(400));
    await expect(middleware(ctx, jest.fn())).rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('refuses when the scope does not survive the round trip', async () => {
    const middleware = setup(['orders']);
    // a parser that keeps fewer parameters than the request: the scope is cut off
    const ctx = strapiCtx('api::order.order.find', junk(20), 10);
    await expect(middleware(ctx, jest.fn())).rejects.toMatchObject({ name: 'ForbiddenError' });
  });

  it('keeps the scope on an ordinary request', async () => {
    const middleware = setup(['orders']);
    const ctx = strapiCtx('api::order.order.find', '_where[status_ne]=cancelled&_sort=id:DESC&_limit=50');
    const next = jest.fn();
    await middleware(ctx, next);
    expect(next).toHaveBeenCalled();
    expect(ctx.query._where._and[0]).toEqual({ _or: [{ 'owner.id': String(ME) }, { 'contact.id_in': ['7'] }] });
  });

  it('leaves full-access users their long queries', async () => {
    const middleware = setup(['projects']);
    const ctx = strapiCtx('api::order.order.find', junk(400));
    const next = jest.fn();
    await middleware(ctx, next);
    expect(next).toHaveBeenCalled();
  });
});
