'use strict';

/**
 * issues/309 (2026-10-21): after the first fixes, production resilience still
 * took 10 s for Tresoreria (treasuries/forecast) and 4.6 s / 6.4 MB for
 * Informes › Dedicació (projects/phases-both): both load every document,
 * payroll, project and logged hour on each call, on a CPU ~6× slower than a
 * laptop. They now load it once, without any filter, through the read cache
 * (issues/307), and apply the query string to it on every request.
 *
 * Guards:
 * - what is loaded goes through the read cache, unfiltered;
 * - phases-both filters by state / year / person / project and leaves out the
 *   phase trees;
 * - neither endpoint writes to what it loaded: the cache shares it between
 *   requests, frozen (calculateEstimatedTotals got a `pure` mode for that).
 */

const deepFreeze = (value, seen = new Set()) => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const k of Object.keys(value)) deepFreeze(value[k], seen);
  return value;
};

// A read cache that runs every loader once per key, freezes and keeps what it
// returns: like the real one with `frozen`, so a write to it throws.
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

const USER = { id: 7, username: 'anna' };

const projectRows = () => [
  {
    id: 1,
    name: 'Actiu',
    trashed: false,
    date_start: '2026-01-01',
    project_state: { id: 1, name: 'Aprovat' },
    leader: { id: 7, username: 'anna' },
    project_scope: { id: 2, name: 'Àmbit', short_name: 'A' },
    default_dedication_type: { id: 3, name: 'Tècnica' },
    project_phases: [
      {
        name: 'F1',
        incomes: [
          {
            quantity: 1,
            amount: 1000,
            date: '2026-03-01',
            estimated_hours: [
              { from: '2025-12-01', to: '2026-02-28', quantity: 10, quantity_type: 'month', users_permissions_user: USER },
            ],
          },
        ],
        expenses: [{ quantity: 2, amount: 50, date: '2026-04-01', paid: false, expense_type: { name: 'X', vat_pct: 21 } }],
      },
    ],
    project_original_phases: [],
  },
  { id: 2, name: 'Tancat', trashed: false, project_state: { id: 2, name: 'Tancat' }, project_phases: [], project_original_phases: [] },
  { id: 3, name: 'Paperera', trashed: true, project_state: { id: 1, name: 'Aprovat' }, project_phases: [], project_original_phases: [] },
];

const activityRows = () => [
  { id: 10, date: '2026-01-05', hours: 2, cost_by_hour: 20, project: { id: 1 }, users_permissions_user: { id: 7 }, activity_type: null, dedication_type: { id: 3 } },
  { id: 11, date: '2025-12-30', hours: 1, cost_by_hour: 20, project: { id: 1 }, users_permissions_user: { id: 7 }, activity_type: null, dedication_type: null },
  { id: 12, date: '2026-01-06', hours: 3, cost_by_hour: 25, project: { id: 1 }, users_permissions_user: { id: 8 }, activity_type: null, dedication_type: null },
  { id: 13, date: '2026-01-07', hours: 4, cost_by_hour: 25, project: { id: 2 }, users_permissions_user: { id: 8 }, activity_type: null, dedication_type: null },
];

describe('projects/phases-both from the read cache (issues/309)', () => {
  let cache;
  let calls;
  let controller;

  beforeEach(() => {
    jest.resetModules();
    cache = fakeReadCache();
    calls = [];
    jest.doMock('../src/services/read-cache', () => ({ getReadCache: () => cache }));
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (uid, build) => (args) => build(args) },
    }));
    const rows = {
      'api::project.project': projectRows,
      'api::activity.activity': activityRows,
      'api::daily-dedication.daily-dedication': () => [
        { id: 1, from: '2025-01-01', to: '2026-12-31', hours: 8, costByHour: 20, users_permissions_user: USER },
      ],
      'api::festive.festive': () => [{ date: '2026-01-06', users_permissions_user: null }],
    };
    global.strapi = {
      contentType: () => ({ attributes: {} }),
      db: {
        query: (uid) => ({
          findMany: async (args) => {
            calls.push([uid, args]);
            return rows[uid] ? rows[uid]() : [];
          },
        }),
      },
    };
    controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });
  });

  afterEach(() => {
    delete global.strapi;
  });

  const ask = (query) =>
    controller.findWithPhasesBoth({ query: { _limit: '-1', activities: 'true', plannedHours: 'true', ...query } });

  it('loads everything once, unfiltered, through the read cache', async () => {
    await ask({ _where: { project_state_in: '1' } });
    await ask({ _where: { project_state_in: '2' }, year: '2026' });

    expect(cache.keys().sort()).toEqual([
      'project.phases-both:activities',
      'project.phases-both:dedications',
      'project.phases-both:festives',
      'project.phases-both:projects',
    ]);
    const projectLoads = calls.filter(([uid]) => uid === 'api::project.project');
    expect(projectLoads).toHaveLength(1);
    expect(projectLoads[0][1].where).toBeUndefined();
  });

  it('filters by state, leaves out the trashed projects and the phase trees', async () => {
    const projects = await ask({ _where: { project_state_in: '1' } });

    expect(projects.map((p) => p.id)).toEqual([1]);
    expect(projects[0]).not.toHaveProperty('project_phases');
    expect(projects[0]).not.toHaveProperty('project_original_phases');
    expect(projects[0].leader).toEqual({ id: 7, username: 'anna' });
    expect(projects[0].activities.map((a) => a.id)).toEqual([10, 11, 12]);
    expect(new Set(projects[0].planned_hours.map((h) => h.year))).toEqual(new Set(['2025', '2026']));
  });

  it('filters the hours by calendar year and person, and by project', async () => {
    const [p] = await ask({ _where: { project_state_in: '1,2' }, year: '2026', user: '7', project: '1' });

    expect(p.id).toBe(1);
    expect(p.activities.map((a) => a.id)).toEqual([10]);
    expect(p.planned_hours.length).toBeGreaterThan(0);
    expect(p.planned_hours.every((h) => h.year === '2026' && h.user === 7)).toBe(true);
  });

  it('answers objects the sanitizer may change without touching the kept ones', async () => {
    const [p] = await ask({ _where: { project_state_in: '1' } });
    delete p.leader.username;
    p.activities.length = 0;
    const [again] = await ask({ _where: { project_state_in: '1' } });
    expect(again.leader.username).toBe('anna');
    expect(again.activities).toHaveLength(3);
  });
});

describe('treasuries/forecast from the read cache (issues/309)', () => {
  let cache;
  let calls;

  beforeEach(() => {
    jest.resetModules();
    cache = fakeReadCache();
    calls = [];
    jest.doMock('../src/services/read-cache', () => ({ getReadCache: () => cache }));
    jest.doMock('../src/services/me-settings', () => ({
      getMe: async () => ({ bank_account_default: { id: 1, name: 'Banc' }, options: { deductible_vat_pct: 100 } }),
    }));
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    const rows = {
      'api::project.project': projectRows,
      'api::year.year': () => [{ id: 1, year: 2026, deductible_vat_pct: 100 }],
      'api::emitted-invoice.emitted-invoice': () => [
        { id: 5, code: 'F-1', emitted: '2026-02-01', paid: false, total: 121, total_base: 100, total_vat: 21, contact: { id: 1, name: 'Client' }, projects: [{ id: 1 }], bank_account: null },
      ],
      'api::payroll.payroll': () => [
        { id: 9, year: { year: 2026 }, month: { month: 3 }, users_permissions_user: USER, net_base: 1000, irpf_base: 150, ss_base: 300, other_base: 0, net_date: '2026-03-31', irpf_date: '2026-04-20', ss_date: '2026-04-30', other_date: '2026-03-31', paid: false, bank_account: null },
      ],
    };
    global.strapi = {
      db: {
        query: (uid) => ({
          findMany: async (args) => {
            calls.push([uid, args]);
            return rows[uid] ? rows[uid]() : [];
          },
          findOne: async () => null,
          count: async () => 0,
        }),
      },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    };
  });

  afterEach(() => {
    delete global.strapi;
  });

  async function forecast(query) {
    const controller = require('../src/api/treasury/controllers/treasury.js');
    const actions = typeof controller === 'function' ? controller({ strapi: global.strapi }) : controller;
    const ctx = { query: { _limit: '-1', year: '2026', periodification: 'prevista', ...query }, state: { user: { id: 1 } } };
    ctx.request = { query: ctx.query };
    return actions.forecast(ctx);
  }

  it('loads every table once through the read cache and filters per request, on frozen data', async () => {
    const all = await forecast({ project_states: '1,2' });
    const approved = await forecast({ project_states: '2' });

    expect(cache.keys()).toEqual(
      expect.arrayContaining(['treasury.forecast:projects', 'treasury.forecast:emitted', 'treasury.forecast:payrolls', 'treasury.forecast:me']),
    );
    expect(calls.filter(([uid]) => uid === 'api::project.project')).toHaveLength(1);
    // the plan of project 1 (state 1) only with its state selected
    const planned = (body) => body.treasury.filter((r) => r.project_id === 1 && /esperad|esperat/i.test(r.type || r.concept || ''));
    expect(all.projects.map((p) => p.id)).toEqual([1, 2]);
    expect(approved.projects.map((p) => p.id)).toEqual([2]);
    expect(planned(approved)).toHaveLength(0);
  });
});

describe('calculateEstimatedTotals pure mode (issues/309)', () => {
  const { calculateEstimatedTotals } = require('../src/api/project/services/projectFinancials');
  const dedications = [{ from: '2025-01-01', to: '2026-12-31', costByHour: 20, users_permissions_user: USER }];

  it('computes the same without writing to the lines', async () => {
    const plain = await calculateEstimatedTotals({ id: 1 }, projectRows()[0].project_phases, dedications, [], true);
    const frozen = deepFreeze(projectRows()[0].project_phases);
    const pure = await calculateEstimatedTotals({ id: 1 }, frozen, dedications, [], true, { pure: true });

    expect(pure.total_estimated_hours).toBe(plain.total_estimated_hours);
    expect(pure.total_estimated_hours_price).toBe(plain.total_estimated_hours_price);
    expect(pure.total_expenses_vat).toBe(plain.total_expenses_vat);
    // a lodash wrapper: compare its values
    expect(pure.totalsByYear.value()).toEqual(plain.totalsByYear.value());
  });

  it('still writes them by default (the project form reads them)', async () => {
    const phases = projectRows()[0].project_phases;
    await calculateEstimatedTotals({ id: 1 }, phases, dedications, [], true);
    expect(phases[0].incomes[0].total_amount).toBe(1000);
    expect(phases[0].incomes[0].estimated_hours[0].total_amount).toBeGreaterThan(0);
    expect(phases[0].expenses[0].total_expenses_vat).toBe(21);
  });
});
