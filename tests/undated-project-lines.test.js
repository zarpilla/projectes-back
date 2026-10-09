'use strict';

/**
 * issues/015 (2026-10-09): a client saw a "9999" year in the project's
 * "Periodificació d'ingressos i despeses" card with no explanation. It comes
 * from income/expense lines with no date: their amounts went to a placeholder
 * year (or to moment's "Invalid date" bucket), the form saved that year into
 * the periodification, and it stayed there.
 *
 * Guards:
 *   - undated lines (zero-amount ones too) are listed so the form can warn;
 *   - every undated row is bucketed under the single UNDATED_YEAR, never
 *     "Invalid date".
 */
const {
  findUndatedLines,
  buildProjectRows,
  aggregateRowsByYear,
  rowYear,
  UNDATED_YEAR,
} = require('../src/api/project/services/projectFinancials');

const ctx = () => ({
  dailyDedications: [],
  festives: [],
  deductibleVatPctByYear: new Map(),
  fallback_deductible_vat_pct: 100,
  activitiesByProject: new Map(),
});

const project = (overrides = {}) => ({
  id: 1,
  name: 'P',
  date_start: '2025-01-01',
  project_phases: [
    {
      name: 'Fase 1',
      incomes: [
        { id: 10, concept: 'Datada', quantity: 1, amount: 100, date: '2025-03-01' },
        { id: 11, concept: 'Sense data', quantity: 1, amount: 50 },
        { id: 12, concept: 'Zero', quantity: 0, amount: 0, date: null, date_estimate_document: null },
        { id: 13, concept: 'Data document', quantity: 1, amount: 10, date_estimate_document: '2026-01-01' },
      ],
      expenses: [{ id: 20, concept: 'Despesa', quantity: 2, amount: 30 }],
    },
  ],
  project_original_phases: [],
  periodification: [],
  ...overrides,
});

describe('findUndatedLines', () => {
  test('lists income and expense lines with no date, including zero-amount ones', () => {
    expect(findUndatedLines(project())).toEqual([
      { id: 11, type: 'income', phase: 'Fase 1', concept: 'Sense data', total_amount: 50 },
      { id: 12, type: 'income', phase: 'Fase 1', concept: 'Zero', total_amount: 0 },
      { id: 20, type: 'expense', phase: 'Fase 1', concept: 'Despesa', total_amount: 60 },
    ]);
  });

  test('returns nothing when every line has a date', () => {
    const p = project({
      project_phases: [{ name: 'F', incomes: [{ id: 1, date: '2025-01-01' }], expenses: [] }],
    });
    expect(findUndatedLines(p)).toEqual([]);
    expect(findUndatedLines({})).toEqual([]);
  });
});

describe('undated rows go to UNDATED_YEAR', () => {
  test('rowYear never returns "Invalid date"', () => {
    expect(rowYear('2025-06-30')).toBe('2025');
    expect(rowYear(undefined)).toBe(UNDATED_YEAR);
    expect(rowYear(null)).toBe(UNDATED_YEAR);
    expect(rowYear('')).toBe(UNDATED_YEAR);
  });

  test('aggregated years contain no "Invalid date" bucket', async () => {
    const rows = await buildProjectRows(project(), ctx());
    const years = aggregateRowsByYear(rows).map((y) => y.year).sort();
    expect(years).toEqual(['2025', '2026', UNDATED_YEAR]);
    const undated = aggregateRowsByYear(rows).find((y) => y.year === UNDATED_YEAR);
    expect(undated.total_estimated_incomes).toBe(50);
    expect(undated.total_estimated_expenses).toBe(60);
  });
});
