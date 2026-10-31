'use strict';

/**
 * issues/372 (security review 2026-10-31): the permissions middleware limits a
 * member or a worker by adding a clause under `_where._and`, which the v3
 * adapter turns into `filters.$and`. A flat query key `$and` was then applied
 * as a field and REPLACED that clause: `/api/orders?$and[0][id][$gt]=0` gave a
 * member the 24,126 orders of every member, `/api/workday-logs?$and…` a worker
 * everyone's clock-ins. `$and.0` walked into the same array.
 *
 * Guards: a flat logical key is refused, and the scope a middleware adds always
 * survives the adaptation.
 */

describe('flat logical keys (issues/372)', () => {
  let adaptQuery;
  let adaptCtxQuery;
  beforeEach(() => {
    jest.resetModules();
    ({ adaptQuery, adaptCtxQuery } = require('../src/services/query-adapter'));
  });

  const scoped = (extra) => ({ _where: { _and: [{ 'owner.id': 7 }] }, ...extra });

  it.each([
    ['$and', { $and: [{ id: { $gt: 0 } }] }],
    ['$or', { $or: [{ id: { $gt: 0 } }] }],
    ['$and.0 path', { '$and.0': 'x' }],
    ['_and', { _and: 'x' }],
    ['_or', { _or: 'x' }],
    ['$not', { $not: { id: 1 } }],
  ])('refuses a flat %s', (_label, extra) => {
    expect(() => adaptQuery(scoped(extra))).toThrow(/no permès/);
    const ctx = { query: scoped(extra) };
    expect(() => adaptCtxQuery(ctx)).toThrow(/no permès/);
  });

  it('keeps the scope with ordinary filters', () => {
    const { filters } = adaptQuery(scoped({ status_ne: 'cancelled', 'route.id': 3 }));
    expect(filters.$and).toEqual([{ owner: { id: 7 } }]);
    expect(filters.status).toEqual({ $ne: 'cancelled' });
    expect(filters.route).toEqual({ id: 3 });
  });

  it('still reads _or / _and inside _where', () => {
    const { filters } = adaptQuery({ _where: { _or: [{ id: 1 }, { id: 2 }] } });
    expect(filters.$or).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
