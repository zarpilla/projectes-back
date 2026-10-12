'use strict';

/**
 * The totals a project shows in lists and pivots are stored in its row
 * (total_real_hours, total_estimated_incomes...) and recomputed when something
 * under it changes. Two maintenance tools sit on top of that:
 *
 *   - refreshAllStoredTotals recomputes every project (POST /projects/refresh-stored-totals);
 *   - verifyStoredTotals reports the projects whose stored totals differ from what
 *     the calculation gives now (GET /projects/verify-stored-totals).
 *
 * The single-project refresh is covered in tests/activity-project-refresh.test.js.
 */

let financials;
let projects;
let calculated;
let written;
let findManyArgs;
let log;

beforeEach(() => {
  jest.resetModules();
  // id -> stored row
  projects = {
    1: { id: 1, name: 'One', total_real_hours: 4, total_incomes: 1000 },
    2: { id: 2, name: 'Two', total_real_hours: 0, total_incomes: null },
    3: { id: 3, name: 'Three', total_real_hours: 1 },
  };
  // id -> what calculateProject returns now
  calculated = {
    1: { total_real_hours: 4, total_incomes: 1000 },
    2: { total_real_hours: 0 },
    3: { total_real_hours: 2.5, total_incomes: '300.10', not_a_stored_field: 9 },
  };
  written = [];
  findManyArgs = [];
  log = { info: jest.fn(), error: jest.fn() };

  global.strapi = {
    db: {
      query: () => ({
        findOne: async ({ where }) => projects[where.id] || null,
        findMany: async (args) => {
          findManyArgs.push(args);
          return Object.values(projects);
        },
      }),
      connection: () => ({
        where: ({ id }) => ({ update: async (data) => written.push({ id, ...data }) }),
      }),
    },
    controller: () => ({
      calculateProject: async (data, id) => {
        if (calculated[id] instanceof Error) throw calculated[id];
        return calculated[id];
      },
    }),
    log,
  };
  financials = require('../src/api/project/services/projectFinancials');
});

afterEach(() => {
  delete global.strapi;
});

describe('pickStoredTotals', () => {
  it('keeps only the stored fields, as numbers, 0 when missing', () => {
    const picked = financials.pickStoredTotals(calculated[3]);

    expect(Object.keys(picked).sort()).toEqual([...financials.STORED_TOTAL_FIELDS].sort());
    expect(picked).toMatchObject({ total_real_hours: 2.5, total_incomes: 300.1, total_expenses: 0 });
    expect(picked.not_a_stored_field).toBeUndefined();
  });
});

describe('refreshAllStoredTotals', () => {
  it('recomputes every project and clears its dirty mark', async () => {
    const result = await financials.refreshAllStoredTotals();

    expect(result).toEqual({ total: 3, processed: 3, failed: 0, errors: [] });
    expect(written.map((w) => w.id)).toEqual([1, 2, 3]);
    expect(written.every((w) => w.dirty === false)).toBe(true);
    expect(written[2]).toMatchObject({ total_real_hours: 2.5, total_incomes: 300.1 });
  });

  it('asks for the projects with real query arguments, not v3 parameters as columns', async () => {
    await financials.refreshAllStoredTotals({ limit: 10 });

    const [args] = findManyArgs;
    expect(JSON.stringify(args)).not.toMatch(/_limit|_sort|published_at_null/);
    expect(args.limit).toBe(10);
    expect(args.orderBy).toEqual([{ id: 'asc' }]);
  });

  it('goes on after a project that fails, and reports it', async () => {
    calculated[2] = new Error('broken phases');
    const result = await financials.refreshAllStoredTotals();

    expect(result).toMatchObject({
      total: 3,
      processed: 2,
      failed: 1,
      errors: [{ id: 2, error: 'broken phases' }],
    });
    expect(written.map((w) => w.id)).toEqual([1, 3]);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('logs its progress every `progressEvery` projects', async () => {
    await financials.refreshAllStoredTotals({ progressEvery: 2 });

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0][0]).toContain('2/3');
  });
});

describe('verifyStoredTotals', () => {
  it('reports the fields whose stored value differs from the calculation', async () => {
    const result = await financials.verifyStoredTotals([1, 2, 3]);

    expect(result).toMatchObject({ total: 3, okCount: 2, diffCount: 1, errorCount: 0 });
    expect(result.report.map((r) => [r.id, r.ok])).toEqual([
      [1, true],
      // stored null counts as 0
      [2, true],
      [3, false],
    ]);
    expect(result.report[2]).toMatchObject({
      name: 'Three',
      diffs: {
        total_real_hours: { stored: 1, computed: 2.5, diff: 1.5 },
        total_incomes: { stored: 0, computed: 300.1 },
      },
    });
  });

  it('tolerates differences up to epsilon', async () => {
    calculated[1] = { total_real_hours: 4.004, total_incomes: 1000 };

    expect((await financials.verifyStoredTotals([1])).okCount).toBe(1);
    expect((await financials.verifyStoredTotals([1], 0.001)).okCount).toBe(0);
  });

  it('reports unknown projects and skips ids that are not ids', async () => {
    const result = await financials.verifyStoredTotals(['1', 99, 'abc', 0, -4]);

    expect(result).toMatchObject({ total: 2, okCount: 1, errorCount: 1 });
    expect(result.report[1]).toEqual({ id: 99, error: 'not found' });
  });

  it('writes nothing', async () => {
    await financials.verifyStoredTotals([1, 2, 3]);

    expect(written).toEqual([]);
  });
});
