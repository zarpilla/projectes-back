'use strict';

/**
 * issues/309 (2026-10-20): Informes › Ingressos/Despeses took 40 s on
 * resilience (projects/economic-detail, 5.7 s on a local copy) and Tresoreria /
 * IVA / Previsió returned 11 MB. Causes and what these tests guard:
 *
 * - every activity (40.000 rows, all columns) was loaded only to add up hours
 *   per month → now summed by the database (loadActivitiesByProjectMonth);
 * - the planned hours built and formatted several moment objects per planned
 *   day → day numbers (dayNumber / dayInfo) and a lean mode of
 *   calculateEstimatedTotals, which must give the same days, hours and costs;
 * - every economic-detail row carried the whole linked invoice (`document`),
 *   which the reports drop on arrival → left out;
 * - the forecast returned every project with all its budget lines, while the
 *   screens only list them → id, name, state and mother.
 */

const moment = require('moment');

const {
  calculateEstimatedTotals,
  groupTotalsByYearMonth,
  groupLeanTotalsByYearMonth,
  dayNumber,
  dayInfo,
  rowYear,
} = require('../src/api/project/services/projectFinancials');

describe('day numbers match moment', () => {
  it('gives the same calendar days and weekdays across DST and leap years', () => {
    const start = moment('2023-12-25', 'YYYY-MM-DD');
    const n0 = dayNumber('2023-12-25');
    for (let i = 0; i < 900; i++) {
      const m = start.clone().add(i, 'days');
      const d = dayInfo(n0 + i);
      expect(d.str).toBe(m.format('YYYY-MM-DD'));
      expect(d.dow).toBe(m.day());
      expect(d.year).toBe(m.format('YYYY'));
    }
  });

  it('treats what moment finds invalid as no date', () => {
    expect(dayNumber('2026-02-30')).toBeNaN();
    expect(dayNumber('nope')).toBeNaN();
    expect(rowYear('2026-02-30')).toBe('9999');
    expect(rowYear(null)).toBe('9999');
    expect(rowYear('2026-03-04')).toBe('2026');
  });
});

describe('lean planned hours', () => {
  const USER = { id: 4 };
  const phases = () => [
    {
      incomes: [
        {
          quantity: 1,
          amount: 100,
          estimated_hours: [
            { from: '2026-03-02', to: '2026-04-15', quantity: 15, quantity_type: 'month', users_permissions_user: USER },
            { from: '2026-10-20', to: '2026-11-10', quantity: 8, quantity_type: 'week', users_permissions_user: USER },
            { from: '2026-12-21', to: '2027-01-08', quantity: 40, users_permissions_user: USER },
          ],
        },
      ],
    },
  ];
  const dedications = [
    { users_permissions_user: USER, from: '2026-01-01', to: '2026-06-30', costByHour: 20 },
    { users_permissions_user: USER, from: '2026-07-01', to: '2027-12-31', costByHour: 25 },
  ];
  const festives = [
    { date: '2026-04-06' },
    { date: '2026-12-25' },
    { date: '2026-03-10', users_permissions_user: USER },
    { date: '2026-03-11', users_permissions_user: { id: 99 } },
  ];

  it('gives the same days, hours and costs as the moment version', async () => {
    const full = await calculateEstimatedTotals({ id: 1 }, phases(), dedications, festives, true);
    const lean = await calculateEstimatedTotals({ id: 1 }, phases(), dedications, festives, true, { lean: true });

    expect(lean.totalsByDay.map((t) => [t.day, t.q, t.costByHour])).toEqual(
      full.totalsByDay.map((t) => [t.day.format('YYYY-MM-DD'), t.q, t.costByHour]),
    );
    expect(lean.total_estimated_hours).toBe(full.total_estimated_hours);
    expect(lean.total_estimated_hours_price).toBe(full.total_estimated_hours_price);
    expect(lean.totalsByYear).toEqual([]);
    // the personal festive of another person is a working day
    expect(lean.totalsByDay.map((t) => t.day)).toContain('2026-03-11');
    expect(lean.totalsByDay.map((t) => t.day)).not.toContain('2026-03-10');
  });

  it('groups by month like groupTotalsByYearMonth', async () => {
    const full = await calculateEstimatedTotals({ id: 1 }, phases(), dedications, festives, true);
    const lean = await calculateEstimatedTotals({ id: 1 }, phases(), dedications, festives, true, { lean: true });

    expect(groupLeanTotalsByYearMonth(lean.totalsByDay)).toEqual(groupTotalsByYearMonth(full.totalsByDay));
  });
});

describe('executed hours summed by the database', () => {
  afterEach(() => {
    delete global.strapi;
  });

  it('groups the sums per project and month, undated ones in 9999/12', async () => {
    jest.resetModules();
    const calls = {};
    const builder = {
      join: (...args) => { calls.join = args; return builder; },
      whereIn: (...args) => { calls.whereIn = args; return builder; },
      groupBy: () => builder,
      select: async () => [
        { project_id: 7, y: 2025, m: 3, hours: '3.00', cost: '100.0000' },
        { project_id: 7, y: null, m: null, hours: '5.00', cost: '150.0000' },
        { project_id: 8, y: 2026, m: 1, hours: null, cost: null },
      ],
    };
    const knex = (table) => { calls.table = table; return builder; };
    knex.raw = (sql) => sql;
    global.strapi = {
      db: {
        connection: knex,
        metadata: {
          get: () => ({
            tableName: 'activities',
            attributes: {
              project: {
                joinTable: {
                  name: 'activities_project_lnk',
                  joinColumn: { name: 'activity_id' },
                  inverseJoinColumn: { name: 'project_id' },
                },
              },
            },
          }),
        },
      },
    };
    const { loadActivitiesByProjectMonth } = require('../src/api/project/services/economic-detail-activities');

    const map = await loadActivitiesByProjectMonth([7, 8]);

    expect(calls.table).toBe('activities as a');
    expect(calls.whereIn).toEqual(['l.project_id', [7, 8]]);
    expect(map.get(7)).toEqual([
      { projectId: 7, year: 2025, month: 3, hours: 3, cost: 100 },
      { projectId: 7, year: 9999, month: 12, hours: 5, cost: 150 },
    ]);
    expect(map.get(8)).toEqual([{ projectId: 8, year: 2026, month: 1, hours: null, cost: 0 }]);
  });
});

describe('economic detail response', () => {
  afterEach(() => {
    delete global.strapi;
  });

  it('loads no activities nor whole documents, and its rows carry no document', async () => {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (uid, build) => (args) => build(args) },
    }));
    jest.doMock('../src/api/project/services/economic-detail-activities', () => ({
      loadActivitiesByProjectMonth: async () => new Map([[1, [{ projectId: 1, year: 2026, month: 2, hours: 3, cost: 60 }]]]),
    }));
    let projectArgs;
    global.strapi = {
      db: {
        query: (uid) => ({
          findMany: async (args) => {
            if (uid !== 'api::project.project') return [];
            projectArgs = args;
            return [
              {
                id: 1,
                name: 'P',
                project_phases: [
                  {
                    name: 'F',
                    incomes: [
                      { quantity: 1, amount: 500, date: '2026-05-01', paid: true, invoice: { id: 3, emitted: '2026-05-02' } },
                    ],
                    expenses: [],
                  },
                ],
                project_original_phases: [],
              },
            ];
          },
        }),
      },
      documents: () => ({ findFirst: async () => ({ options: {} }) }),
    };
    const controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });

    const rows = await controller.findWithEconomicDetail({ query: {} });

    expect(projectArgs.populate.activities).toBeUndefined();
    expect(projectArgs.populate.project_phases.populate.incomes.populate.invoice).toEqual({
      select: ['id', 'emitted', 'paid_date', 'total_vat'],
    });
    expect(rows.filter((r) => r.type === 'income').map((r) => [r.income_esti, r.income_real])).toEqual([
      [500, 0],
      [0, 500],
    ]);
    expect(rows.find((r) => r.type === 'real_hours')).toMatchObject({ total_real_hours: 3, total_real_hours_price: -60 });
    expect(rows.some((r) => 'document' in r)).toBe(false);
  });
});

describe('forecast projects', () => {
  afterEach(() => {
    delete global.strapi;
  });

  it('lists the projects with only what the screens read', async () => {
    jest.resetModules();
    jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ options: {} }) }));
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    global.strapi = {
      db: {
        query: (uid) => ({
          findMany: async () =>
            uid === 'api::project.project'
              ? [
                  {
                    id: 5,
                    name: 'Fill',
                    project_state: { id: 1, name: 'Aprovat' },
                    mother: { id: 4, name: 'Mare' },
                    project_phases: [{ incomes: [{ quantity: 1, amount: 10 }], expenses: [] }],
                  },
                ]
              : [],
          findOne: async () => null,
          count: async () => 0,
        }),
      },
      log: { info () {}, warn () {}, error () {}, debug () {} },
    };
    const controller = require('../src/api/treasury/controllers/treasury.js');
    const actions = typeof controller === 'function' ? controller({ strapi: global.strapi }) : controller;
    const ctx = { query: { _limit: '-1', year: '2026', periodification: 'no' }, state: { user: { id: 1 } } };
    ctx.request = { query: ctx.query };

    const body = await actions.forecast(ctx);

    expect(body.projects).toEqual([
      { id: 5, name: 'Fill', project_state: { id: 1, name: 'Aprovat' }, mother: { id: 4, name: 'Mare' } },
    ]);
  });
});
