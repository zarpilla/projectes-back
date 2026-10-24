'use strict';

const { mockMarkDirty } = require('./helpers/mark-dirty');

/**
 * issues/259 (2026-10-20, review 8): «Total» planned-hours lines shorter than
 * ~15 days were dropped from the stored project totals. The startup script
 * marks dirty every project with a «Total» (or untyped) hours line in its
 * current or original plan, so the totals cron recomputes them.
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

describe('refreshTotalHoursTotals (issues/259)', () => {
  beforeEach(() => jest.resetModules());
  afterEach(() => {
    delete global.strapi;
  });

  it('marks dirty the projects with «Total» hours lines', async () => {
    mockStrapi([{ id: 75 }, { id: 781 }]);
    const { refreshTotalHoursTotals } = require('../src/services/refresh-total-hours-totals');

    await refreshTotalHoursTotals();

    expect(global.strapi.db.query).toHaveBeenCalledWith('api::project.project');
    const total = {
      incomes: { estimated_hours: { $or: [{ quantity_type: 'total' }, { quantity_type: { $null: true } }] } },
    };
    expect(findMany.mock.calls[0][0].where).toEqual({
      $or: [{ project_phases: total }, { project_original_phases: total }],
    });
    expect(updates).toEqual([{ table: 'project_totals', col: 'project_id', ids: [75, 781], data: { dirty: true } }]);
  });

  it('writes nothing when no project has «Total» hours lines', async () => {
    mockStrapi([]);
    const { refreshTotalHoursTotals } = require('../src/services/refresh-total-hours-totals');

    await refreshTotalHoursTotals();

    expect(updates).toEqual([]);
  });
});
