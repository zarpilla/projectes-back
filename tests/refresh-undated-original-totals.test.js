'use strict';

const { mockMarkDirty } = require('./helpers/mark-dirty');

/**
 * issues/195 (2026-10-19): an original-budget line without date was left out
 * of the project's Original totals (the undated bucket was dropped when only
 * its original totals were non-zero). The startup script marks dirty every
 * project with an undated original line, so the totals cron recomputes them.
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

describe('refreshUndatedOriginalTotals (issues/195)', () => {
  beforeEach(() => jest.resetModules());
  afterEach(() => {
    delete global.strapi;
  });

  it('marks dirty the projects with undated original lines', async () => {
    mockStrapi([{ id: 75 }, { id: 781 }]);
    const { refreshUndatedOriginalTotals } = require('../src/services/refresh-undated-original-totals');

    await refreshUndatedOriginalTotals();

    expect(global.strapi.db.query).toHaveBeenCalledWith('api::project.project');
    const undated = { date: { $null: true }, date_estimate_document: { $null: true } };
    expect(findMany.mock.calls[0][0].where).toEqual({
      $or: [{ project_original_phases: { incomes: undated } }, { project_original_phases: { expenses: undated } }],
    });
    expect(updates).toEqual([{ table: 'project_totals', col: 'project_id', ids: [75, 781], data: { dirty: true } }]);
  });

  it('writes nothing when no project has undated original lines', async () => {
    mockStrapi([]);
    const { refreshUndatedOriginalTotals } = require('../src/services/refresh-undated-original-totals');

    await refreshUndatedOriginalTotals();

    expect(updates).toEqual([]);
  });
});
