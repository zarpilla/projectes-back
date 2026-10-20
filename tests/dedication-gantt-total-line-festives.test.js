'use strict';

/**
 * issues/289 (2026-10-20, review 9): since issues/259 a «Total» line is spread
 * over the working days of its whole range, skipping festives. «Previsió
 * dedicació» (projects/dedications) only loaded the chosen year's festives, so
 * for a line crossing the year end the other year's holidays counted as
 * working days and the chosen year got fewer planned hours than phases-both,
 * Dedicació and the project's Resum (Arran 2026: 8.616 vs 8.649 h). It now
 * loads every festive, as phases-both does; the capacity still counts only the
 * chosen year's days (issues/265).
 */

const { buildPlannedHoursByMonth } = require('../src/api/project/services/projectFinancials');

const USER = { id: 2, username: 'rosa' };
const PERIODS = [{ id: 1, from: '2025-01-01', to: '2027-12-31', hours: 8, costByHour: 20 }];
const FESTIVES = [
  { date: '2025-12-30', users_permissions_user: { id: USER.id } },
  { date: '2025-12-31', users_permissions_user: null },
  { date: '2026-01-01', users_permissions_user: null },
];

// 29/12/2025–09/01/2026: 10 weekdays, 3 of them festive -> 7 working days,
// 1 in 2025 and 6 in 2026.
const project = () => ({
  id: 159,
  name: 'Total creuant l’any',
  trashed: false,
  project_phases: [
    {
      incomes: [
        {
          quantity: 1,
          amount: 0,
          estimated_hours: [
            { from: '2025-12-29', to: '2026-01-09', quantity: 70, quantity_type: 'total', users_permissions_user: USER },
          ],
        },
      ],
    },
  ],
});

// Honours a date range on the festives query, like the database does.
function festivesFor(params) {
  const range = params && params.where && params.where.date;
  if (!range) return FESTIVES;
  return FESTIVES.filter((f) => (!range.$gte || f.date >= range.$gte) && (!range.$lte || f.date <= range.$lte));
}

function mockStrapi(p) {
  const users = [{ ...USER, hidden: false, daily_dedications: PERIODS, permissions: [{ permission: 'projects' }] }];
  global.strapi = {
    db: {
      query: (uid) => ({
        findMany: async (params) => {
          if (uid === 'api::project.project') return [p];
          if (uid === 'plugin::users-permissions.user') return users;
          if (uid === 'api::festive.festive') return festivesFor(params);
          return [];
        },
      }),
    },
  };
}

describe('Previsió dedicació: «Total» lines crossing the year end (issues/289)', () => {
  beforeEach(() => {
    jest.resetModules();
    mockStrapi(project());
  });
  afterEach(() => {
    delete global.strapi;
  });

  it.each([2025, 2026])('gives %i the same planned hours as phases-both', async (year) => {
    const { buildDedicationGantt } = require('../src/api/project/services/dedicationGantt');
    const { cells, dedications } = await buildDedicationGantt({ projectStateIds: [1], year, view: 'month' });

    const reference = await buildPlannedHoursByMonth(
      project(),
      PERIODS.map((dd) => ({ ...dd, users_permissions_user: { id: USER.id } })),
      FESTIVES,
    );
    const expected = reference.filter((r) => r.year === String(year)).reduce((s, r) => s + r.estimated_hours, 0);
    expect(expected).toBeCloseTo(year === 2025 ? 10 : 60, 6);

    const total = dedications.reduce((s, d) => s + d.estimated_hours, 0);
    expect(total).toBeCloseTo(expected, 6);
    const month = year === 2025 ? '2025-12' : '2026-01';
    expect(Number(cells[USER.id][month].hours)).toBeCloseTo(expected, 2);
  });

  it('keeps the capacity to the chosen year’s days', async () => {
    const { buildDedicationGantt } = require('../src/api/project/services/dedicationGantt');
    const { cells } = await buildDedicationGantt({ projectStateIds: [1], year: 2026, view: 'week' });
    // 2026-W01: 29/12/2025–04/01/2026; only 1–2 Jan count, 1 Jan is festive.
    expect(cells[USER.id]['2026-W01'].expected).toBe(8);
    expect(cells[USER.id]['2026-W01'].festive).toBe(8);
  });
});
