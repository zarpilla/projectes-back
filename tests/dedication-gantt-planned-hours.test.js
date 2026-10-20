'use strict';

/**
 * issues/237 (2026-10-19, review 7): «Previsió dedicació» computed planned
 * hours with its own formula: «h/mes» lines were spread as quantity/30 per
 * weekday (~70 %: «Quim 15 h/mes» gave 10,5 h in Oct 2026), the year was
 * filtered with isoWeekYear (a «DES '25» column), every year from the chosen
 * one onward was added up (columns to DES '27), and months without planned
 * hours had no column. It now reads the planned hours from the same source as
 * the project page, Prev./Real and Informes › Dedicació
 * (buildPlannedHoursByMonth, issues/067), over Jan–Dec of the chosen year.
 */

const { buildPlannedHoursByMonth } = require('../src/api/project/services/projectFinancials');

const USER = { id: 2, username: 'quim' };
const PERIODS = [{ id: 1, from: '2025-01-01', to: '2027-12-31', hours: 8, costByHour: 20 }];
const FESTIVES = [
  { date: '2026-10-12', users_permissions_user: null },
  { date: '2026-10-13', users_permissions_user: { id: USER.id } },
];

const project = () => ({
  id: 276,
  name: 'Quim 15 h/mes',
  trashed: false,
  project_phases: [
    {
      incomes: [
        {
          quantity: 1,
          amount: 0,
          estimated_hours: [
            // across the year boundaries on both sides
            { from: '2025-12-01', to: '2027-06-01', quantity: 15, quantity_type: 'month', users_permissions_user: USER },
          ],
        },
      ],
    },
  ],
});

function mockStrapi(p) {
  const users = [{ ...USER, hidden: false, daily_dedications: PERIODS, permissions: [{ permission: 'projects' }] }];
  global.strapi = {
    db: {
      query: (uid) => ({
        findMany: async () => {
          if (uid === 'api::project.project') return [p];
          if (uid === 'plugin::users-permissions.user') return users;
          if (uid === 'api::festive.festive') return FESTIVES;
          return [];
        },
      }),
    },
  };
}

describe('Previsió dedicació planned hours (issues/237)', () => {
  beforeEach(() => {
    jest.resetModules();
    mockStrapi(project());
  });
  afterEach(() => {
    delete global.strapi;
  });

  it('gives each month the same planned hours as the project page and Prev./Real', async () => {
    const { buildDedicationGantt } = require('../src/api/project/services/dedicationGantt');
    const { cells } = await buildDedicationGantt({ projectStateIds: [1], year: 2026, view: 'month' });

    const reference = await buildPlannedHoursByMonth(
      project(),
      PERIODS.map((dd) => ({ ...dd, users_permissions_user: { id: USER.id } })),
      FESTIVES,
    );
    const ref2026 = reference.filter((r) => r.year === '2026');
    expect(ref2026).toHaveLength(12);
    for (const r of ref2026) {
      expect(Number(cells[USER.id][`2026-${r.month}`].hours)).toBeCloseTo(r.estimated_hours, 2);
    }
    // ~15 h a month, not ~70 % of it (October: 22 weekdays − 2 festives)
    expect(Number(cells[USER.id]['2026-10'].hours)).toBeCloseTo((15 / 5 / 4.3) * 20, 2);
  });

  it('shows Jan–Dec of the chosen year only, every month present', async () => {
    const { buildDedicationGantt } = require('../src/api/project/services/dedicationGantt');
    const { periods, dedications } = await buildDedicationGantt({ projectStateIds: [1], year: 2026, view: 'month' });
    expect(periods.map((p) => p.key)).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
      '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12',
    ]);
    expect(new Set(dedications.map((d) => d.year))).toEqual(new Set([2026]));
  });

  it('keeps the months without planned hours (a line ending in July)', async () => {
    const p = project();
    p.project_phases[0].incomes[0].estimated_hours[0].to = '2026-08-01';
    mockStrapi(p);
    const { buildDedicationGantt } = require('../src/api/project/services/dedicationGantt');
    const { periods, cells } = await buildDedicationGantt({ projectStateIds: [1], year: 2026, view: 'month' });
    expect(periods).toHaveLength(12);
    expect(cells[USER.id]['2026-08']).toMatchObject({ hours: '0.00', cssClass: 'dedication-empty' });
  });

  it('shows every week of the year in the week view', async () => {
    const { buildDedicationGantt } = require('../src/api/project/services/dedicationGantt');
    const { periods } = await buildDedicationGantt({ projectStateIds: [1], year: 2026, view: 'week' });
    // 2026 starts on a Thursday: ISO weeks 1–53
    expect(periods).toHaveLength(53);
    expect(periods[0].key).toBe('2026-W01');
    expect(periods[52].key).toBe('2026-W53');
  });
});
