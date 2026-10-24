'use strict';

const { mockMarkDirty } = require('./helpers/mark-dirty');

/**
 * issues/067 (2026-10-17): on Arran de Terra, 9 projects of 2022–23 stored
 * 4.5–160 planned hours more than their phase lines give, so the projects panel
 * kept disagreeing with «Prev./Real dedicació» for them. The startup script
 * marks dirty every project with planned-hours lines, current or original, so
 * the totals cron recomputes them.
 */

let updates;
let findMany;

function mockStrapi(projects) {
  updates = [];
  mockMarkDirty((ids) => updates.push({ table: 'project_totals', col: 'project_id', ids, data: { dirty: true } }));
  findMany = jest.fn(async () => projects);
  global.strapi = {
    log: { info: jest.fn() },
    db: {
      query: jest.fn(() => ({ findMany })),
      connection: jest.fn((table) => ({
        whereIn: jest.fn((col, ids) => ({
          update: jest.fn(async (data) => updates.push({ table, col, ids, data })),
        })),
      })),
    },
  };
}

describe('refreshPlannedHoursTotals (issues/067)', () => {
  beforeEach(() => jest.resetModules());
  afterEach(() => {
    delete global.strapi;
  });

  it('marks dirty the projects with planned-hours lines in either plan', async () => {
    mockStrapi([{ id: 138 }, { id: 142 }]);
    const { refreshPlannedHoursTotals } = require('../src/services/refresh-planned-hours-totals');

    await refreshPlannedHoursTotals();

    expect(global.strapi.db.query).toHaveBeenCalledWith('api::project.project');
    const withHours = { incomes: { estimated_hours: { id: { $notNull: true } } } };
    expect(findMany.mock.calls[0][0].where).toEqual({
      $or: [{ project_phases: withHours }, { project_original_phases: withHours }],
    });
    expect(updates).toEqual([{ table: 'project_totals', col: 'project_id', ids: [138, 142], data: { dirty: true } }]);
  });

  it('writes nothing when no project has planned hours', async () => {
    mockStrapi([]);
    const { refreshPlannedHoursTotals } = require('../src/services/refresh-planned-hours-totals');

    await refreshPlannedHoursTotals();

    expect(updates).toEqual([]);
  });
});
