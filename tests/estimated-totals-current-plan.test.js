'use strict';

/**
 * issues/283 (2026-10-20, review 8): Justificacions «Previstes» read
 * `GET /projects/estimated-totals`, which computed the planned hours from the
 * original budget (`project_original_phases`): Coòpolis showed 4.308,15 € for
 * 2025 against 5.176,97 € on the fitxa. User decision: «Previstes» uses the
 * current estimate (`project_phases`), like the project's «Hores previstes».
 */

const USER = { id: 7 };
const phases = (from, to, quantity) => [
  {
    incomes: [
      {
        quantity: 1,
        amount: 0,
        estimated_hours: [{ from, to, quantity, quantity_type: 'total', users_permissions_user: USER }],
      },
    ],
  },
];

describe('GET /projects/estimated-totals (issues/283)', () => {
  let controller;
  let projectFindMany;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (uid, build) => (args) => build(args) },
    }));
    projectFindMany = jest.fn(async () => [
      {
        id: 1,
        name: 'P',
        // current plan: 10 h on Wednesday 4 March 2026; original: 99 h in 2025
        project_phases: phases('2026-03-04', '2026-03-04', 10),
        project_original_phases: phases('2025-03-05', '2025-03-05', 99),
      },
    ]);
    const queries = {
      'api::project.project': { findMany: projectFindMany },
      'api::daily-dedication.daily-dedication': {
        findMany: async () => [{ users_permissions_user: USER, from: '2026-01-01', to: '2026-12-31', costByHour: 20 }],
      },
      'api::festive.festive': { findMany: async () => [] },
    };
    global.strapi = {
      contentType: () => ({ attributes: {} }),
      db: { query: (uid) => queries[uid] },
    };
    controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('spreads the hours of the current estimate, not of the original budget', async () => {
    const rows = await controller.findEstimatedTotalsByDay({ query: {} });

    expect(rows.map((r) => [r.day, r.q, r.costByHour, r.project])).toEqual([['2026-03-04', 10, 20, 1]]);
    const populate = JSON.stringify(projectFindMany.mock.calls[0][0].populate);
    expect(populate).toContain('project_phases');
    expect(populate).not.toContain('project_original_phases');
  });

  it('keeps only the asked calendar year', async () => {
    expect(await controller.findEstimatedTotalsByDay({ query: { year: '2025' } })).toEqual([]);
    expect(await controller.findEstimatedTotalsByDay({ query: { year: '2026' } })).toHaveLength(1);
  });
});
