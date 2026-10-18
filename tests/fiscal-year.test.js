'use strict';

const { fiscalYearStartMonth, fiscalYearOf, fiscalYearEnd } = require('../src/services/fiscal-year');
const {
  buildProjectRows,
  aggregateRowsByYear,
  UNDATED_YEAR,
} = require('../src/api/project/services/projectFinancials');

describe('fiscal year helpers', () => {
  test('start month comes from me.options, 1 when unset or invalid', () => {
    expect(fiscalYearStartMonth({ options: { fiscal_year_start_month: 9 } })).toBe(9);
    expect(fiscalYearStartMonth({ options: {} })).toBe(1);
    expect(fiscalYearStartMonth(null)).toBe(1);
    expect(fiscalYearStartMonth({ options: { fiscal_year_start_month: 13 } })).toBe(1);
  });

  test('a fiscal year is named by the year it starts in', () => {
    expect(fiscalYearOf('2026-08-31', 9)).toBe('2025');
    expect(fiscalYearOf('2026-09-01', 9)).toBe('2026');
    expect(fiscalYearOf('2027-01-15T10:00:00.000Z', 9)).toBe('2026');
    expect(fiscalYearOf('2026-01-01', 1)).toBe('2026');
    expect(fiscalYearOf(null, 9)).toBeNull();
  });

  test('last day of a fiscal year', () => {
    expect(fiscalYearEnd(2026, 1)).toBe('2026-12-31');
    expect(fiscalYearEnd('2026', 9)).toBe('2027-08-31');
    expect(fiscalYearEnd(2027, 3)).toBe('2028-02-29');
  });
});

describe('project rows by fiscal year', () => {
  const project = {
    id: 1,
    name: 'Curs',
    project_phases: [
      {
        name: 'Fase',
        incomes: [
          { concept: 'Matrícules tardor', quantity: 1, amount: 1000, date_estimate_document: '2026-10-01' },
          { concept: 'Matrícules primavera', quantity: 1, amount: 500, date_estimate_document: '2027-03-01' },
          { concept: 'Estiu', quantity: 1, amount: 200, date_estimate_document: '2027-09-10' },
          { concept: 'Sense data', quantity: 1, amount: 50 },
        ],
        expenses: [],
      },
    ],
    project_original_phases: [],
    periodification: [{ year: '2026', incomes: 10, expenses: 0, real_incomes: 0, real_expenses: 0 }],
  };
  const ctx = (fiscalYearStartMonth) => ({
    dailyDedications: [],
    festives: [],
    deductibleVatPctByYear: new Map(),
    fallback_deductible_vat_pct: 100,
    activitiesByProject: new Map(),
    fiscalYearStartMonth,
  });
  const incomesByYear = (rows) =>
    Object.fromEntries(aggregateRowsByYear(rows).map((y) => [y.year, y.total_estimated_incomes]));

  test('September–August: lines and periodification fall in their fiscal year', async () => {
    const rows = await buildProjectRows(structuredClone(project), ctx(9));
    expect(incomesByYear(rows)).toEqual({ 2026: 1510, 2027: 200, [UNDATED_YEAR]: 50 });
    const periodification = rows.find((r) => r.row_type === 'Periodificació');
    expect(periodification).toMatchObject({ date: '2027-08-31', year: '2026', month: '08' });
  });

  test('calendar year unchanged (no setting)', async () => {
    const rows = await buildProjectRows(structuredClone(project), ctx(undefined));
    expect(incomesByYear(rows)).toEqual({ 2026: 1010, 2027: 700, [UNDATED_YEAR]: 50 });
    const periodification = rows.find((r) => r.row_type === 'Periodificació');
    expect(periodification).toMatchObject({ date: '2026-12-31', year: '2026', month: '12' });
  });
});
