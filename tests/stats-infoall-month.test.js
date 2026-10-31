'use strict';

/**
 * issues/043 (2026-10-14): #/orders-stats and #/incidences-stats offer the year
 * "Tots" next to a month. GET /api/orders/infoall?month=10 (no year) built the
 * range `undefined-10-01` and the date column refused it ("Invalid format,
 * expected yyyy-MM-dd" -> 500). /api/incidences/infoall did the same on a
 * datetime column, so it answered nothing instead. A month without a year means
 * that month of every year.
 */

const path = require('path');

const API = path.join(__dirname, '..', 'src', 'api');

function load(apiName, rows) {
  jest.resetModules();
  const calls = [];
  const ct = { uid: `api::${apiName}.${apiName}`, modelName: apiName, apiName, kind: 'collectionType', attributes: {} };
  global.strapi = {
    contentType: () => ct,
    contentTypes: { [ct.uid]: ct },
    log: { warn: () => {}, info: () => {} },
    db: {
      query: () => ({
        findMany: async (args) => {
          calls.push(args);
          return rows;
        },
      }),
    },
  };
  const ctrl = require(path.join(API, apiName, 'controllers', `${apiName}.js`))({ strapi: global.strapi });
  return { ctrl, calls };
}

const whereDates = (where) => JSON.stringify(where);

describe('GET /api/orders/infoall', () => {
  const rows = [
    { id: 1, status: 'pending', estimated_delivery_date: '2025-10-03' },
    { id: 2, status: 'pending', estimated_delivery_date: '2026-10-20' },
    { id: 3, status: 'pending', estimated_delivery_date: '2026-09-30' },
  ];

  it('a month without a year: that month of every year', async () => {
    const { ctrl, calls } = load('order', rows);
    const result = await ctrl.infoAll({ query: { _limit: '-1', month: '10' } });
    expect(whereDates(calls[0].where)).not.toContain('undefined');
    expect(result.map((o) => o.id)).toEqual([1, 2]);
  });

  it('a month of a year', async () => {
    const { ctrl, calls } = load('order', rows);
    const result = await ctrl.infoAll({ query: { _limit: '-1', year: '2026', month: '10' } });
    expect(whereDates(calls[0].where)).toContain('2026-10-01');
    expect(whereDates(calls[0].where)).toContain('2026-10-31');
    expect(result.map((o) => o.id)).toEqual([2]);
  });
});

describe('GET /api/orders/infoall?_group=route', () => {
  const rows = [
    { id: 1, status: 'pending', estimated_delivery_date: '2026-10-03', route: { id: 4, short_name: 'DT - MARESME' } },
    { id: 2, status: 'invoiced', estimated_delivery_date: '2026-10-20', route: { id: 4, short_name: 'DT - MARESME' } },
    { id: 3, status: 'cancelled', estimated_delivery_date: '2026-10-21', route: { id: 4, short_name: 'DT - MARESME' } },
    { id: 4, status: 'pending', estimated_delivery_date: '2026-10-22', route: { id: 5, name: 'Girona' } },
    { id: 5, status: 'pending', estimated_delivery_date: '2026-10-22' },
    { id: 6, status: 'pending', estimated_delivery_date: '2025-10-22', route: { id: 5, name: 'Girona' } },
  ];

  it('counts the orders of the period per route, without the cancelled ones', async () => {
    const { ctrl, calls } = load('order', rows);
    const result = await ctrl.infoAll({ query: { _limit: '-1', year: '2026', month: '10', _group: 'route' } });
    expect(calls[0].select).toBeDefined();
    expect(JSON.stringify(calls[0].where)).not.toContain('_group');
    expect(result).toEqual([
      { route: 'DT - MARESME', count: 2 },
      { route: 'Girona', count: 1 },
      { route: '-', count: 1 },
    ]);
  });
});

describe('GET /api/incidences/infoall', () => {
  const rows = [
    { id: 1, state: 'open', createdAt: '2025-10-03T10:00:00.000Z' },
    { id: 2, state: 'open', createdAt: '2026-10-20T10:00:00.000Z' },
    { id: 3, state: 'open', createdAt: '2026-09-30T10:00:00.000Z' },
  ];

  it('a month without a year: that month of every year', async () => {
    const { ctrl, calls } = load('incidence', rows);
    const result = await ctrl.infoAll({ query: { _limit: '-1', month: '10' } });
    expect(whereDates(calls[0].where)).not.toContain('undefined');
    expect(result.map((i) => i.id)).toEqual([1, 2]);
  });

  it('a month of a year', async () => {
    const { ctrl, calls } = load('incidence', rows.filter((r) => r.id === 2));
    await ctrl.infoAll({ query: { _limit: '-1', year: '2026', month: '10' } });
    expect(calls[0].where.created_at).toEqual({ $gte: '2026-10-01', $lt: '2026-11-01' });
  });

  // 2026-10-31: an incidence created that day was missing from October's
  // «Informe d'incidències» (`created_at <= 2026-10-31` = before midnight); the
  // e2e test that counts a new incidence failed only on the last day of a month.
  it("keeps the period's last day: a whole year ends before 1 January", async () => {
    const { ctrl, calls } = load('incidence', []);
    await ctrl.infoAll({ query: { _limit: '-1', year: '2026' } });
    expect(calls[0].where.created_at).toEqual({ $gte: '2026-01-01', $lt: '2027-01-01' });
  });

  it('gives the member and route ids, not the populated relations', async () => {
    const order = { id: 9, owner: { id: 58, fullname: 'Muda' }, route: { id: 4, short_name: 'DT - MARESME' } };
    const { ctrl } = load('incidence', [{ id: 5, state: 'closed', createdAt: '2026-10-12T10:00:00.000Z', order }]);
    const [row] = await ctrl.infoAll({ query: { _limit: '-1' } });
    expect(row).toMatchObject({ owner: '58', owner_name: 'Muda', route: '4', route_name: 'DT - MARESME' });
  });
});
