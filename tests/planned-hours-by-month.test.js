/**
 * issues/067 (2026-10-16): the projects panel and "Prev./Real dedicació" gave
 * different planned hours for the same project. The panel shows the stored
 * `total_estimated_hours` (per working day, skipping festives, only lines with a
 * person); Prev./Real rebuilt the hours in the browser from the phase lines with
 * its own month-based rules. Prev./Real now asks `GET /projects/phases-both
 * ?plannedHours=true`, whose `planned_hours` come from the same per-day rows as
 * the stored total, so the two must add up to the same number.
 */
const {
  buildPlannedHoursByMonth,
  buildProjectRows,
  aggregateRowsByYear,
} = require('../src/api/project/services/projectFinancials');

const USER = { id: 7, username: 'anna' };
const OTHER = { id: 8, username: 'pere' };
const DEDICATIONS = [{ users_permissions_user: USER, from: '2026-01-01', to: '2026-12-31', costByHour: 20 }];
const FESTIVES = [{ date: '2026-03-04' }, { date: '2026-03-05', users_permissions_user: USER }];

const phases = (estimated_hours) => [{ incomes: [{ quantity: 1, amount: 0, estimated_hours }] }];

// A project with every kind of hours line the two screens used to count differently.
const project = () => ({
  id: 1,
  name: 'P',
  date_start: '2026-01-01',
  project_phases: phases([
    // 40 h a month over February and March: spread per working day, festives skipped
    { from: '2026-02-02', to: '2026-04-01', quantity: 40, quantity_type: 'month', users_permissions_user: USER },
    // 10 h a week over two weeks across the end of March
    { from: '2026-03-23', to: '2026-04-06', quantity: 10, quantity_type: 'week', users_permissions_user: OTHER },
    // 30 h in total, spread over the working days of May to July (issues/259)
    { from: '2026-05-01', to: '2026-08-01', quantity: 30, users_permissions_user: USER },
    // no person: the stored total leaves it out
    { from: '2026-02-02', to: '2026-04-01', quantity: 99, quantity_type: 'month' },
  ]),
  project_original_phases: phases([
    { from: '2026-02-02', to: '2026-03-02', quantity: 20, quantity_type: 'month', users_permissions_user: USER },
  ]),
});

const storedTotals = async (p) => {
  const rows = await buildProjectRows(p, {
    dailyDedications: DEDICATIONS,
    festives: FESTIVES,
    deductibleVatPctByYear: new Map(),
    fallback_deductible_vat_pct: 100,
    activitiesByProject: new Map(),
  });
  const byYear = aggregateRowsByYear(rows);
  const sum = (field) => byYear.reduce((acc, y) => acc + (y[field] || 0), 0);
  return { estimated: sum('total_estimated_hours'), original: sum('total_original_hours') };
};

const sum = (rows, field) => rows.reduce((acc, r) => acc + r[field], 0);

describe('planned hours by person and month (issues/067)', () => {
  it('add up to the stored totals of the project', async () => {
    const planned = await buildPlannedHoursByMonth(project(), DEDICATIONS, FESTIVES, '2026-10-17');
    const stored = await storedTotals(project());

    expect(stored.estimated).toBeGreaterThan(0);
    expect(sum(planned, 'estimated_hours')).toBeCloseTo(stored.estimated, 9);
    expect(sum(planned, 'original_estimated_hours')).toBeCloseTo(stored.original, 9);
  });

  it('split by person and month, leaving out the lines without a person', async () => {
    const planned = await buildPlannedHoursByMonth(project(), DEDICATIONS, FESTIVES, '2026-10-17');

    expect(planned.map((r) => `${r.year}-${r.month} ${r.user}`)).toEqual([
      '2026-02 7',
      '2026-03 7',
      '2026-03 8',
      '2026-04 8',
      '2026-05 7',
      '2026-06 7',
      '2026-07 7',
    ]);
    const march = planned.find((r) => r.month === '03' && r.user === 7);
    // 22 working days in March 2026 minus the two festives = 20 days of 40 / 5 / 4.3 h
    expect(march.estimated_hours).toBeCloseTo((20 * 40) / 5 / 4.3, 9);
    // the original plan stops at 2 March
    expect(march.original_estimated_hours).toBe(0);
    // 10 h a week: 7 working days in March, 3 in April (Monday 6 is not counted)
    expect(planned.find((r) => r.month === '03' && r.user === 8).estimated_hours).toBe(14);
    expect(planned.find((r) => r.month === '04' && r.user === 8).estimated_hours).toBe(6);
    // June has 22 of the 66 working days from 1 May to 1 August
    expect(planned.find((r) => r.month === '06').estimated_hours).toBeCloseTo(10, 9);
  });

  it('count the planned hours up to today', async () => {
    const planned = await buildPlannedHoursByMonth(project(), DEDICATIONS, FESTIVES, '2026-03-24');
    const at = (month, user) => planned.find((r) => r.month === month && r.user === user);

    expect(at('02', 7).estimated_hours_today).toBe(at('02', 7).estimated_hours);
    // the week line starts on Monday 23: two days of 2 h by the 24th
    expect(at('03', 8).estimated_hours_today).toBe(4);
    expect(at('04', 8).estimated_hours_today).toBe(0);
    expect(at('05', 7).estimated_hours_today).toBe(0);
  });

  it('are empty for a project without phases', async () => {
    expect(await buildPlannedHoursByMonth({ id: 2, name: 'Q' }, DEDICATIONS, FESTIVES)).toEqual([]);
  });
});

describe('GET /projects/phases-both?plannedHours=true', () => {
  let controller;
  let findMany;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (uid, build) => (args) => build(args) },
    }));
    findMany = jest.fn(async () => []);
    global.strapi = {
      contentType: () => ({ attributes: {} }),
      db: {
        query: (uid) => ({
          findMany: async (args) => {
            findMany(uid, args);
            if (uid === 'api::project.project') return [project(), { ...project(), id: 3, trashed: true }];
            if (uid === 'api::daily-dedication.daily-dedication') return DEDICATIONS;
            if (uid === 'api::festive.festive') return FESTIVES;
            return [];
          },
        }),
      },
    };
    controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('adds each project its planned hours, matching its stored total', async () => {
    const projects = await controller.findWithPhasesBoth({ query: { plannedHours: 'true' } });

    expect(projects.map((p) => p.id)).toEqual([1]);
    expect(sum(projects[0].planned_hours, 'estimated_hours')).toBeCloseTo(
      (await storedTotals(project())).estimated,
      9,
    );
  });

  it('leaves them out unless asked', async () => {
    const projects = await controller.findWithPhasesBoth({ query: {} });

    expect(projects[0].planned_hours).toBeUndefined();
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
