/**
 * issues/171 (2026-10-18): the Ingressos/Despeses detall and Preu hora reports
 * (`projects/economic-detail`) never loaded the projects' periodification, so
 * pushPeriodificationRows had nothing to add and the yearly figures differed
 * from the form's (project 583: 2024 0 € in the report against 7.599,97 € in
 * the form). The search branch (`_q`) loaded nothing at all.
 */

describe('economic detail: periodification', () => {
  let controller;
  let projectArgs;

  const PROJECT = {
    id: 583,
    name: 'P',
    is_mother: false,
    project_phases: [],
    project_original_phases: [],
    activities: [],
    periodification: [{ year: '2024', incomes: 0, expenses: 0, real_incomes: 7599.97, real_expenses: 100 }],
  };

  beforeEach(() => {
    jest.resetModules();
    // the executed hours are summed by the database (issues/309)
    jest.doMock('../src/api/project/services/economic-detail-activities', () => ({
      loadActivitiesByProjectMonth: async () => new Map(),
    }));
    projectArgs = [];
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (uid, build) => (args) => build(args) },
    }));
    global.strapi = {
      db: {
        query: (uid) => ({
          findMany: async (args) => {
            if (uid !== 'api::project.project') return [];
            projectArgs.push(args);
            // like the database: a component comes only when it is populated
            const { periodification, ...rest } = PROJECT;
            return [args.populate && args.populate.periodification ? { ...rest, periodification } : rest];
          },
        }),
      },
      documents: () => ({ findFirst: async () => ({ options: {} }) }),
    };
    controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });
  });

  afterEach(() => {
    delete global.strapi;
  });

  const periodificationRows = (rows) => rows.filter((r) => r.row_type === 'Periodificació');

  it('adds the periodification rows of each year', async () => {
    const rows = await controller.findWithEconomicDetail({ query: {} });
    const rows2024 = periodificationRows(rows).filter((r) => r.year === '2024');
    expect(rows2024.find((r) => r.type === 'income').income_real).toBe(7599.97);
    expect(rows2024.find((r) => r.type === 'expense').expense_real).toBe(-100);
  });

  it('also when searching by name', async () => {
    const rows = await controller.findWithEconomicDetail({ query: { _q: 'P' } });
    expect(projectArgs[0].populate).toMatchObject({ periodification: true, project_phases: expect.any(Object) });
    expect(periodificationRows(rows)).toHaveLength(2);
  });
});
