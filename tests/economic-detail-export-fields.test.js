'use strict';

/**
 * issues/142, issues/143 (2026-10-18) — Raiels: the "Exporta detall" file of
 * the economic detail had no forecast invoicing/payment dates, and its VAT
 * columns were 0 even for movements with VAT. Those columns (`*_vat`) hold
 * only the non-deductible VAT, which is 0 when VAT is 100 % deductible.
 *
 * Guards that every budget line row of /projects/economic-detail carries the
 * line's "Previsió fac." and "Previsió pag." dates and its whole VAT.
 */
beforeEach(() => {
  jest.resetModules();
});

const ctx = () => ({
  // all VAT deductible: the non-deductible `*_vat` columns stay 0
  deductibleVatPctByYear: new Map([['2026', 100]]),
  fallback_deductible_vat_pct: 100,
  activitiesByProject: new Map(),
  dailyDedications: [],
  festives: [],
});

const line = (extra) => ({
  concept: 'c',
  quantity: 2,
  amount: 100,
  date_estimate_document: '2026-03-15',
  date: '2026-04-30',
  ...extra,
});

const project = () => {
  const paidInvoice = { id: 9, emitted: '2026-03-20', total_vat: 99 };
  const phase = () => ({
    name: 'F',
    incomes: [
      line({ vat_pct: 21, income_type: { name: 'Venda', vat_pct: 21 } }),
      line({ vat_pct: 10, paid: true, invoice: paidInvoice }),
    ],
    expenses: [
      line({ vat_pct: 4, expense_type: { name: 'Llibres', vat_pct: 21 } }),
      line({ expense_type: { name: 'Altres', vat_pct: 0 }, date: null }),
      line({ paid: true, invoice: paidInvoice }),
    ],
  });
  return {
    id: 1,
    name: 'P',
    date_start: '2026-01-01',
    project_phases: [phase()],
    project_original_phases: [phase()],
  };
};

const pick = (r) => [
  r.type,
  r.forecast_invoice_date,
  r.forecast_payment_date,
  r.vat_pct,
  r.vat,
];

describe('economic detail rows of a budget line', () => {
  it('carry its forecast dates and whole VAT, in the budget, the execution and the original budget', async () => {
    const { buildProjectRows } = require('../src/api/project/services/projectFinancials');
    const rows = await buildProjectRows(project(), ctx());

    const lineRows = rows.filter((r) => r.type === 'income' || r.type === 'expense');
    const esti = lineRows.filter((r) => r.income_esti || r.expense_esti).map(pick);
    const real = lineRows.filter((r) => r.income_real || r.expense_real).map(pick);
    const orig = lineRows.filter((r) => r.income_orig || r.expense_orig).map(pick);

    const budget = [
      ['income', '2026-03-15', '2026-04-30', 21, 42],
      ['income', '2026-03-15', '2026-04-30', 10, 20],
      // the line's own VAT wins over its type's
      ['expense', '2026-03-15', '2026-04-30', 4, -8],
      // a 0 % type is 0; a line without a payment forecast has no date
      ['expense', '2026-03-15', null, 0, 0],
      // no VAT anywhere: 21
      ['expense', '2026-03-15', '2026-04-30', 21, -42],
    ];
    expect(esti).toEqual(budget);
    expect(orig).toEqual(budget);
    expect(real).toEqual([
      ['income', '2026-03-15', '2026-04-30', 10, 20],
      ['expense', '2026-03-15', '2026-04-30', 21, -42],
    ]);

    // the non-deductible VAT is still 0 when all VAT is deductible
    expect(lineRows.every((r) => !r.expense_esti_vat && !r.expense_real_vat && !r.expense_orig_vat)).toBe(true);
  });
});

describe('VAT of a budgeted expense line in the totals (issues/143)', () => {
  it("takes the line's own VAT before its type's, and the type's (or 21) when the line has none", async () => {
    const { calculateEstimatedTotals } = require('../src/api/project/services/projectFinancials');
    const expense = (vat_pct, expense_type) => ({ quantity: 2, amount: 100, date: '2026-07-01', vat_pct, expense_type });
    const phases = [
      {
        expenses: [
          expense(4, { vat_pct: 21 }),
          expense(0, { vat_pct: 21 }),
          expense(null, { vat_pct: 10 }),
          expense(undefined, { vat_pct: 0 }),
          expense(null, undefined),
        ],
      },
    ];

    const result = await calculateEstimatedTotals({ id: 1, date_start: '2026-01-01' }, phases, [], [], false);

    expect(phases[0].expenses.map((e) => e.total_expenses_vat)).toEqual([8, 0, 20, 0, 42]);
    expect(result.total_expenses_vat).toBe(70);
  });
});

describe('lineVatOverType startup script (issues/143)', () => {
  const PHASE_EXPENSE = 'api::phase-expense.phase-expense';
  let updates;
  let queries;

  function mockStrapi({ stale, lines, phaseRows }) {
    updates = [];
    queries = [];
    global.strapi = {
      log: { info: jest.fn(), warn: jest.fn() },
      db: {
        query: jest.fn((uid) => ({
          findMany: jest.fn(async (args) => {
            queries.push({ uid, where: args.where });
            if (args.where.vat_pct === 21) return stale;
            if (args.where.id) return phaseRows;
            return lines;
          }),
        })),
        metadata: { get: jest.fn(() => ({ tableName: 'phase_expenses' })) },
        connection: jest.fn((table) => ({
          whereIn: jest.fn((col, ids) => ({
            update: jest.fn(async (data) => updates.push({ table, ids, data })),
          })),
        })),
      },
    };
  }

  afterEach(() => {
    delete global.strapi;
  });

  it('sets lines at 21 % on a 0 % type to 0 and marks dirty the projects whose lines have another VAT than their type', async () => {
    mockStrapi({
      stale: [{ id: 1 }, { id: 2 }],
      lines: [
        { id: 1, vat_pct: 0, expense_type: { vat_pct: 0 } },
        { id: 3, vat_pct: 21, expense_type: { vat_pct: '10.00' } },
        { id: 4, vat_pct: 10, expense_type: { vat_pct: '10.00' } },
        { id: 5, vat_pct: 21, expense_type: null },
        { id: 6, vat_pct: 4, expense_type: null },
      ],
      phaseRows: [
        { id: 3, project_phase: { project: { id: 10 } } },
        { id: 6, project_original_phase: { project: { id: 11 } } },
      ],
    });
    const { lineVatOverType } = require('../src/services/line-vat-over-type');

    await lineVatOverType();

    expect(queries[0]).toEqual({ uid: PHASE_EXPENSE, where: { vat_pct: 21, expense_type: { vat_pct: 0 } } });
    expect(queries[2]).toEqual({ uid: PHASE_EXPENSE, where: { id: { $in: [3, 6] } } });
    expect(updates).toEqual([
      { table: 'phase_expenses', ids: [1, 2], data: { vat_pct: 0 } },
      { table: 'projects', ids: [10, 11], data: { dirty: true } },
    ]);
  });

  it('writes nothing when every line agrees with its type', async () => {
    mockStrapi({ stale: [], lines: [{ id: 4, vat_pct: 10, expense_type: { vat_pct: 10 } }], phaseRows: [] });
    const { lineVatOverType } = require('../src/services/line-vat-over-type');

    await lineVatOverType();

    expect(updates).toEqual([]);
  });
});
