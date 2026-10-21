'use strict';

/**
 * issues/307 (2026-10-21): Informes › Ingressos/Despeses and Preu hora
 * (projects/economic-detail) took 6.8 s in production, on every change of
 * chip: every project was loaded and its rows computed again. The rows of
 * every published, non-mother project are now computed once and kept by the
 * read cache; each request only filters them by state, year and paid.
 *
 * Guards:
 * - one load of the projects, without any state filter, for every request;
 * - the same rows, in the same order, as computing them for the request;
 * - the state («Sense estat» = 0), year and paid filters;
 * - answers are copies: the kept rows are shared and frozen.
 */

const deepFreeze = (value, seen = new Set()) => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const k of Object.keys(value)) deepFreeze(value[k], seen);
  return value;
};

// Runs every loader once per key and keeps its result frozen, like the real
// cache with `frozen`.
function fakeReadCache() {
  const kept = new Map();
  return {
    keys: () => [...kept.keys()],
    get: async (key, loader) => {
      if (!kept.has(key)) kept.set(key, deepFreeze(await loader()));
      return kept.get(key);
    },
  };
}

const USER = { id: 7 };
const line = (concept, amount, date, extra = {}) => ({ concept, quantity: 1, amount, date, ...extra });

const projectRows = () => [
  {
    id: 1,
    name: 'Actiu',
    date_start: '2025-01-01',
    project_state: { id: 1, name: 'Actiu' },
    leader: { id: 7, username: 'anna' },
    project_phases: [
      {
        name: 'F1',
        incomes: [
          line('Factura 1', 1000, '2025-11-10', { paid: true }),
          line('Factura 2', 2000, '2026-02-01', {
            estimated_hours: [
              { from: '2026-01-05', to: '2026-01-30', quantity: 20, quantity_type: 'total', users_permissions_user: USER },
            ],
          }),
        ],
        expenses: [line('Despesa', 300, '2026-01-15', { expense_type: { name: 'Serveis', vat_pct: 21 } })],
      },
    ],
    project_original_phases: [{ name: 'F1', incomes: [line('Factura 1', 900, '2025-11-10')], expenses: [] }],
  },
  {
    id: 2,
    name: 'Tancat',
    project_state: { id: 2, name: 'Tancat' },
    project_phases: [{ name: 'F', incomes: [line('Única', 500, '2026-03-01', { paid: true })], expenses: [] }],
    project_original_phases: [],
  },
  {
    id: 3,
    name: 'Sense estat',
    project_state: null,
    project_phases: [{ name: 'F', incomes: [line('Única', 700, '2025-06-01')], expenses: [] }],
    project_original_phases: [],
    periodification: [{ year: 2026, incomes: 100, expenses: 0, real_incomes: 0, real_expenses: 0 }],
  },
  // a mother: its children carry the figures
  {
    id: 4,
    name: 'Mare',
    is_mother: true,
    project_state: { id: 1, name: 'Actiu' },
    project_phases: [{ name: 'F', incomes: [line('Mare', 9999, '2026-01-01')], expenses: [] }],
    project_original_phases: [],
  },
];

describe('projects/economic-detail from the read cache (issues/307)', () => {
  let cache;
  let projectLoads;
  let controller;

  beforeEach(() => {
    jest.resetModules();
    cache = fakeReadCache();
    projectLoads = [];
    jest.doMock('../src/services/read-cache', () => ({ getReadCache: () => cache }));
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (uid, build) => (args) => build(args) },
    }));
    jest.doMock('../src/api/project/services/economic-detail-activities', () => ({
      loadActivitiesByProjectMonth: async () =>
        new Map([[1, [{ projectId: 1, year: 2026, month: 1, hours: 10, cost: 200 }]]]),
    }));
    const rows = {
      'api::project.project': projectRows,
      'api::daily-dedication.daily-dedication': () => [
        { id: 1, from: '2025-01-01', to: '2026-12-31', hours: 8, costByHour: 20, users_permissions_user: USER },
      ],
      'api::festive.festive': () => [{ date: '2026-01-06', users_permissions_user: null }],
      'api::year.year': () => [{ year: 2026, deductible_vat_pct: 80 }],
    };
    global.strapi = {
      db: {
        query: (uid) => ({
          findMany: async (args) => {
            if (uid === 'api::project.project') projectLoads.push(args);
            return rows[uid] ? rows[uid]() : [];
          },
        }),
      },
      documents: () => ({ findFirst: async () => ({ options: { deductible_vat_pct: 90 } }) }),
    };
    controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });
  });

  afterEach(() => {
    delete global.strapi;
  });

  const ask = (query) => controller.findWithEconomicDetail({ query });
  const ids = (rows) => [...new Set(rows.map((r) => r.id))].sort();

  it('loads and computes once, without any state filter, for every request', async () => {
    await ask({ _where: { project_state_in: '1' } });
    await ask({ _where: { project_state_in: '2,0', year_eq: '2026' } });
    await ask({ _where: { project_state_in: '1,2' }, paid: 'true' });

    expect(projectLoads).toHaveLength(1);
    expect(JSON.stringify(projectLoads[0].where || {})).not.toContain('project_state');
    expect(cache.keys().sort()).toEqual([
      'calendars:daily-dedications',
      'calendars:festives',
      `project.economic-detail:${new Date().getFullYear()}`,
    ]);
  });

  it('answers the same rows, in the same order, as computing them for the request', async () => {
    // a search by name is still computed on the projects the database finds
    // (here every one of them)
    const computed = await ask({ _q: 'a' });
    const kept = await ask({});
    expect(kept).toEqual(computed);
    expect(kept.length).toBeGreaterThan(5);
    expect(kept.some((r) => r.row_type === 'Hores reals')).toBe(true);
    expect(kept.some((r) => r.row_type === 'Periodificació')).toBe(true);
  });

  it('filters by state, «Sense estat», year and paid', async () => {
    expect(ids(await ask({ _where: { project_state_in: '1' } }))).toEqual([1]);
    expect(ids(await ask({ _where: { project_state_in: '1,0' } }))).toEqual([1, 3]);
    expect(ids(await ask({ _where: { project_state_in: ['2'] } }))).toEqual([2]);
    expect(ids(await ask({}))).toEqual([1, 2, 3]);

    const of2026 = await ask({ _where: { project_state_in: '1,2,0', year_eq: '2026' } });
    expect(of2026.length).toBeGreaterThan(0);
    expect(of2026.every((r) => r.year === '2026')).toBe(true);

    const paid = await ask({ _where: { project_state_in: '1,2,0' }, paid: 'true' });
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.every((r) => r.paid === true)).toBe(true);
    const unpaid = await ask({ _where: { project_state_in: '1,2,0' }, paid: 'false' });
    expect(unpaid.every((r) => r.paid === false)).toBe(true);
  });

  it('leaves out the mothers and the documents', async () => {
    const rows = await ask({});
    expect(rows.some((r) => r.id === 4)).toBe(false);
    expect(rows.some((r) => 'document' in r)).toBe(false);
  });

  it('answers copies: what a caller changes is not kept', async () => {
    const first = await ask({ _where: { project_state_in: '1' } });
    // the response sanitizer deletes fields of what it answers
    for (const row of first) {
      delete row.project_name;
      row.year = 'x';
    }
    const again = await ask({ _where: { project_state_in: '1' } });
    expect(again.every((r) => r.project_name === 'Actiu' && r.year !== 'x')).toBe(true);
  });
});
