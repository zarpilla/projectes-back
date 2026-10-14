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
    expect(whereDates(calls[0].where)).toContain('2026-10-01');
    expect(whereDates(calls[0].where)).toContain('2026-10-31');
  });
});
