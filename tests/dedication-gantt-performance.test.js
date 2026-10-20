'use strict';

/**
 * issues/309 (2026-10-20): Informes › Previsió dedicació took 10 s on
 * resilience. projects/dedications answered 12 MB on every load (33.639
 * per-day rows, only read by «Exporta») and computed every planned day with
 * moment. The screen now asks with rows=false; the days are computed without
 * moment and must give the same weeks and rows.
 */

const moment = require('moment');

const USER = { id: 2, username: 'quim' };
const project = () => ({
  id: 276,
  name: 'P',
  trashed: false,
  project_phases: [
    {
      incomes: [
        {
          quantity: 1,
          amount: 0,
          estimated_hours: [
            { from: '2025-12-15', to: '2027-01-10', quantity: 15, quantity_type: 'month', users_permissions_user: USER },
          ],
        },
      ],
    },
  ],
});

beforeEach(() => {
  jest.resetModules();
  const users = [
    {
      ...USER,
      hidden: false,
      daily_dedications: [{ id: 1, from: '2025-01-01', to: '2027-12-31', hours: 8, costByHour: 20 }],
      permissions: [{ permission: 'projects' }],
    },
  ];
  global.strapi = {
    db: {
      query: (uid) => ({
        findMany: async () => {
          if (uid === 'api::project.project') return [project()];
          if (uid === 'plugin::users-permissions.user') return users;
          return [];
        },
      }),
    },
  };
});
afterEach(() => {
  delete global.strapi;
});

describe('Previsió dedicació without moment (issues/309)', () => {
  it('gives the ISO weeks of moment, across year ends', () => {
    const { isoWeekOf, periodKeyFromDate } = require('../src/api/project/services/dedicationGantt');
    const { dayNumber } = require('../src/api/project/services/projectFinancials');
    const start = moment('2019-12-20', 'YYYY-MM-DD');
    for (let i = 0; i < 2600; i++) {
      const m = start.clone().add(i, 'days');
      const str = m.format('YYYY-MM-DD');
      expect(isoWeekOf(dayNumber(str))).toEqual({ year: m.isoWeekYear(), week: m.isoWeek() });
      expect(periodKeyFromDate(str, 'week')).toBe(`${m.isoWeekYear()}-W${String(m.isoWeek()).padStart(2, '0')}`);
    }
  });

  it('builds the per-day rows of the chosen year as before', async () => {
    const { buildDedicationGantt } = require('../src/api/project/services/dedicationGantt');
    const { dedications } = await buildDedicationGantt({ projectStateIds: [1], year: 2026, view: 'month' });

    expect(dedications.length).toBeGreaterThan(200);
    for (const d of dedications) {
      const m = moment(d.from, 'YYYY-MM-DD');
      expect(d.year).toBe(2026);
      expect(d.month).toBe(m.format('MM'));
      expect(d.week).toBe(m.isoWeek());
      expect(d.to).toBe(m.clone().add(1, 'day').format('YYYY-MM-DD'));
    }
  });

  it('leaves out the per-day rows with rows: false, same cells', async () => {
    const { buildDedicationGantt } = require('../src/api/project/services/dedicationGantt');
    const all = await buildDedicationGantt({ projectStateIds: [1], year: 2026, view: 'week' });
    const lean = await buildDedicationGantt({ projectStateIds: [1], year: 2026, view: 'week', rows: false });

    expect(all.dedications.length).toBeGreaterThan(0);
    expect(lean.dedications).toEqual([]);
    expect(lean.cells).toEqual(all.cells);
    expect(lean.periods).toEqual(all.periods);
  });

  it('the endpoint reads rows=false from the query', async () => {
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (uid, build) => (args) => build(args) },
    }));
    const controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });
    const ask = (query) => controller.findDedications({ query: { _where: { project_state_in: '1' }, year: '2026', ...query } });

    expect((await ask({ rows: 'false' })).dedications).toEqual([]);
    expect((await ask({})).dedications.length).toBeGreaterThan(0);
  });
});
