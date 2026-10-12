'use strict';

/**
 * issues/033 (2026-10-12) — the project totals read a 0 % expense type as
 * "no VAT set" and budgeted its lines at 21 % VAT.
 *
 * Guards the rule (0 is 0; no type, or a type without VAT, is 21) in the
 * three places that apply it, the seed, and the startup script that sets the
 * seeded VAT-free types to 0 and marks the affected projects dirty.
 */
const EXPENSE_TYPE = 'api::expense-type.expense-type';
const PHASE_EXPENSE = 'api::phase-expense.phase-expense';

beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  delete global.strapi;
});

describe('VAT of a budgeted expense line', () => {
  const line = (expense_type) => ({
    concept: 'c',
    quantity: 2,
    amount: 100,
    date: '2026-07-01',
    expense_type,
  });
  const lines = () => [
    line({ vat_pct: 0 }),
    line({ vat_pct: 10 }),
    line({ vat_pct: null }),
    line({}),
    line(undefined),
  ];

  it('is 0 for a 0 % type and 21 % without a type or without its VAT, in the totals', async () => {
    const { calculateEstimatedTotals } = require('../src/api/project/services/projectFinancials');
    const phases = [{ expenses: lines() }];

    const result = await calculateEstimatedTotals({ id: 1, date_start: '2026-01-01' }, phases, [], [], false);

    expect(phases[0].expenses.map((e) => e.total_expenses_vat)).toEqual([0, 20, 42, 42, 42]);
    expect(result.total_expenses_vat).toBe(0 + 20 + 42 + 42 + 42);
    expect(result.totalsByYear.value()[0].total_expenses_vat).toBe(146);
  });

  it('is the same in the rows of the budget and of the original budget', async () => {
    const { buildProjectRows } = require('../src/api/project/services/projectFinancials');
    const p = {
      id: 1,
      name: 'P',
      date_start: '2026-01-01',
      project_phases: [{ name: 'F', expenses: lines() }],
      project_original_phases: [{ name: 'F', expenses: lines() }],
    };

    // nothing deductible, so the whole VAT of each line shows up
    const rows = await buildProjectRows(p, {
      deductibleVatPctByYear: new Map([['2026', 0]]),
      fallback_deductible_vat_pct: 100,
      projectDefaultYear: '2026',
      activitiesByProject: new Map(),
      dailyDedications: [],
      festives: [],
    });

    const vatOf = (amount, vat) =>
      rows.filter((r) => r.type === 'expense' && r[amount]).map((r) => Math.abs(r[vat]));
    const estimated = vatOf('expense_esti', 'expense_esti_vat');
    const original = vatOf('expense_orig', 'expense_orig_vat');
    expect(estimated).toEqual([0, 20, 42, 42, 42]);
    expect(original).toEqual([0, 20, 42, 42, 42]);
  });
});

describe('seed', () => {
  it('gives every expense type a VAT', () => {
    const seed = require('../src/services/new-database-seed-data');
    const types = seed.CATALOGS[EXPENSE_TYPE];

    expect(types.length).toBeGreaterThan(0);
    for (const type of types) expect(typeof type.vat_pct).toBe('number');
    const { ZERO_VAT_NAMES } = require('../src/services/zero-vat-expense-types');
    for (const name of ZERO_VAT_NAMES) expect(types.find((t) => t.name === name).vat_pct).toBe(0);
  });
});

describe('zeroVatExpenseTypes', () => {
  let updates;
  let queries;

  function mockStrapi({ unsetTypes, phaseExpenses }) {
    updates = [];
    queries = [];
    global.strapi = {
      log: { info: jest.fn(), warn: jest.fn() },
      db: {
        query: jest.fn((uid) => ({
          findMany: jest.fn(async (args) => {
            queries.push({ uid, where: args.where });
            return uid === EXPENSE_TYPE ? unsetTypes : phaseExpenses;
          }),
        })),
        metadata: { get: jest.fn(() => ({ tableName: 'expense_types' })) },
        connection: jest.fn((table) => ({
          whereIn: jest.fn((col, ids) => ({
            update: jest.fn(async (data) => updates.push({ table, ids, data })),
          })),
        })),
      },
    };
  }

  it('sets the seeded VAT-free types still without VAT to 0 and marks the projects using 0 % types dirty', async () => {
    mockStrapi({
      unsetTypes: [
        { id: 7, name: 'Quotes' },
        { id: 8, name: 'Comissions bancàries' },
      ],
      phaseExpenses: [
        { id: 1, project_phase: { project: { id: 10 } } },
        { id: 2, project_original_phase: { project: { id: 11 } } },
        { id: 3, project_phase: { project: { id: 10 } } },
      ],
    });
    const { zeroVatExpenseTypes, ZERO_VAT_NAMES } = require('../src/services/zero-vat-expense-types');

    await zeroVatExpenseTypes();

    // only the known names, and only while empty
    expect(queries[0]).toEqual({
      uid: EXPENSE_TYPE,
      where: { name: { $in: ZERO_VAT_NAMES }, vat_pct: null },
    });
    expect(queries[1]).toEqual({ uid: PHASE_EXPENSE, where: { expense_type: { vat_pct: 0 } } });
    expect(updates).toEqual([
      { table: 'expense_types', ids: [7, 8], data: { vat_pct: 0 } },
      { table: 'projects', ids: [10, 11], data: { dirty: true } },
    ]);
  });

  it('writes nothing when there is nothing to fix', async () => {
    mockStrapi({ unsetTypes: [], phaseExpenses: [] });
    const { zeroVatExpenseTypes } = require('../src/services/zero-vat-expense-types');

    await zeroVatExpenseTypes();

    expect(updates).toEqual([]);
  });
});
