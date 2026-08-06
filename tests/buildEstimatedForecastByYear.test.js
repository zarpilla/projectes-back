'use strict';

/**
 * Jest tests for buildEstimatedForecastByYear — ported from v3 standalone assert tests.
 * Exercises the economic forecast ("prevista") helper (R4 guardrail).
 */
const { buildEstimatedForecastByYear } = require('../src/api/project/services/projectFinancials');

const approx = (a, b, eps = 1e-9) => {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);
};

const project = (id, overrides = {}) => ({
  id,
  name: `Project ${id}`,
  date_start: '2025-01-01',
  project_phases: [],
  periodification: [],
  ...overrides,
});
const phase = (incomes = [], expenses = []) => ({ incomes, expenses });
const income = (quantity, amount, date, date_estimate_document) => ({
  quantity,
  amount,
  date,
  date_estimate_document,
  income_type: { name: 'Venda' },
  paid: false,
});
const expense = (
  quantity,
  amount,
  date,
  date_estimate_document,
  expense_type = { name: 'Subministrament', vat_pct: 21 },
) => ({
  quantity,
  amount,
  date,
  date_estimate_document,
  expense_type,
  paid: false,
});
const periodification = (year, incomes, expenses, real_incomes = 0, real_expenses = 0) => ({
  year: String(year),
  incomes,
  expenses,
  real_incomes,
  real_expenses,
});
const vatMap = (entries) => new Map(entries.map(([y, pct]) => [String(y), pct]));

describe('buildEstimatedForecastByYear (financial engine — R4 guardrail)', () => {
  test('returns empty object for no projects', () => {
    expect(buildEstimatedForecastByYear([], vatMap([]), 100)).toEqual({});
    expect(buildEstimatedForecastByYear(null, vatMap([]), 100)).toEqual({});
  });

  test('sums planned income lines (paid or not) by previsió year', () => {
    const p = project(1, {
      project_phases: [
        phase([income(2, 100, '2025-01-01'), income(1, 50, '2025-06-01'), income(3, 10, '2026-03-01')], []),
      ],
    });
    const out = buildEstimatedForecastByYear([p], vatMap([]), 100);
    approx(out['2025'].forecast_incomes, 250);
    approx(out['2025'].forecast_expenses, 0);
    approx(out['2026'].forecast_incomes, 30);
  });

  test('dates lines by date_estimate_document || date', () => {
    const p = project(1, {
      project_phases: [
        phase([income(1, 100, '2026-01-01', '2025-09-01')], [expense(1, 200, '2026-01-01', '2025-09-01')]),
      ],
    });
    const out = buildEstimatedForecastByYear([p], vatMap([['2025', 100]]), 100);
    approx(out['2025'].forecast_incomes, 100);
    approx(out['2025'].forecast_expenses, 200);
    approx(out['2025'].forecast_expenses_vat, 0);
    expect(out['2026']).toBeUndefined();
  });

  test('computes VAT prorrata from year-specific deductible_vat_pct', () => {
    const p = project(1, { project_phases: [phase([], [expense(1, 1000, '2025-01-01', '2025-01-01')])] });
    const out = buildEstimatedForecastByYear([p], vatMap([['2025', 80]]), 100);
    approx(out['2025'].forecast_expenses, 1000);
    approx(out['2025'].forecast_expenses_vat, 42);
  });

  test('falls back to global deductible_vat_pct when year is missing', () => {
    const p = project(1, { project_phases: [phase([], [expense(1, 1000, '2025-01-01', '2025-01-01')])] });
    const out = buildEstimatedForecastByYear([p], vatMap([]), 80);
    approx(out['2025'].forecast_expenses_vat, 42);
  });

  test('aggregates across multiple projects, keeps expenses positive', () => {
    const p1 = project(1, { project_phases: [phase([], [expense(1, 1000, '2025-01-01', '2025-01-01')])] });
    const p2 = project(2, { project_phases: [phase([income(5, 20, '2025-02-01')], [])] });
    const out = buildEstimatedForecastByYear([p1, p2], vatMap([['2025', 100]]), 100);
    approx(out['2025'].forecast_incomes, 100);
    approx(out['2025'].forecast_expenses, 1000);
  });

  test('periodification=no ignores periodification entirely', () => {
    const p = project(1, {
      project_phases: [phase([income(1, 100, '2025-01-01')], [expense(1, 200, '2025-01-01', '2025-01-01')])],
      periodification: [periodification(2025, 300, 500, 700, 900)],
    });
    const outExplicit = buildEstimatedForecastByYear([p], vatMap([['2025', 100]]), 100, 'no');
    const outDefault = buildEstimatedForecastByYear([p], vatMap([['2025', 100]]), 100);
    for (const out of [outExplicit, outDefault]) {
      approx(out['2025'].forecast_incomes, 100);
      approx(out['2025'].forecast_expenses, 200);
      approx(out['2025'].forecast_expenses_vat, 0);
    }
  });

  test('periodification=prevista layers pp.incomes / pp.expenses', () => {
    const p = project(1, {
      project_phases: [phase([income(1, 100, '2025-01-01')], [expense(1, 200, '2025-01-01', '2025-01-01')])],
      periodification: [periodification(2025, 300, 500, 700, 900)],
    });
    const out = buildEstimatedForecastByYear([p], vatMap([['2025', 100]]), 100, 'prevista');
    approx(out['2025'].forecast_incomes, 400);
    approx(out['2025'].forecast_expenses, 700);
    approx(out['2025'].forecast_expenses_vat, 0);
  });

  test('periodification=real layers pp.real_incomes / pp.real_expenses', () => {
    const p = project(1, {
      project_phases: [phase([income(1, 100, '2025-01-01')], [expense(1, 200, '2025-01-01', '2025-01-01')])],
      periodification: [periodification(2025, 300, 500, 700, 900)],
    });
    const out = buildEstimatedForecastByYear([p], vatMap([['2025', 100]]), 100, 'real');
    approx(out['2025'].forecast_incomes, 800);
    approx(out['2025'].forecast_expenses, 1100);
    approx(out['2025'].forecast_expenses_vat, 0);
  });

  test('periodification is dated 31/12 of its year', () => {
    const p = project(1, { periodification: [periodification(2025, 0, 1000)] });
    const out = buildEstimatedForecastByYear([p], vatMap([['2025', 100]]), 100, 'prevista');
    approx(out['2025'].forecast_expenses, 1000);
    expect(out['2026']).toBeUndefined();
  });
});
