'use strict';

/**
 * Jest tests for aggregateRowsByYear — ported from the v3 standalone assert-based tests.
 * These exercise the PURE financial-engine aggregation logic (no Strapi), serving as
 * the R4 guardrail (financial totals must not diverge between v3 and v5).
 */
const { aggregateRowsByYear } = require('../src/api/project/services/projectFinancials');

const approx = (a, b, eps = 1e-9) => {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);
};

describe('aggregateRowsByYear (financial engine — R4 guardrail)', () => {
  test('returns empty array for no rows', () => {
    expect(aggregateRowsByYear([])).toEqual([]);
  });

  test('groups rows by year and flips expense signs to positive', () => {
    const rows = [
      { year: '2025', income_esti: 1000, expense_esti: -300, expense_esti_vat: -63 },
      { year: '2025', income_esti: 500 },
      { year: '2026', income_esti: 200, expense_esti: -50 },
    ];
    const out = aggregateRowsByYear(rows);
    expect(out.length).toBe(2);

    const y2025 = out.find((y) => y.year === '2025');
    approx(y2025.total_estimated_incomes, 1500);
    approx(y2025.total_estimated_expenses, 300);
    approx(y2025.total_estimated_expenses_vat, 63);
    approx(y2025.estimated_incomes_expenses, 1500 - 300 - 0 - 63);

    const y2026 = out.find((y) => y.year === '2026');
    approx(y2026.total_estimated_incomes, 200);
    approx(y2026.total_estimated_expenses, 50);
    approx(y2026.estimated_incomes_expenses, 150);
  });

  test('populates all three dimensions (original / estimated / real)', () => {
    const rows = [
      {
        year: '2025',
        income_orig: 1000,
        income_esti: 1100,
        income_real: 900,
        expense_orig: -200,
        expense_esti: -250,
        expense_real: -180,
        expense_orig_vat: -42,
        expense_esti_vat: -52,
        expense_real_vat: -38,
        total_original_hours: 10,
        total_estimated_hours: 12,
        total_real_hours: 9,
        total_original_hours_price: -500,
        total_estimated_hours_price: -600,
        total_real_hours_price: -450,
      },
    ];
    const [y] = aggregateRowsByYear(rows);

    approx(y.total_original_incomes, 1000);
    approx(y.total_original_expenses, 200);
    approx(y.total_original_expenses_vat, 42);
    approx(y.total_original_hours, 10);
    approx(y.total_original_hours_price, 500);
    approx(y.original_incomes_expenses, 1000 - 200 - 500 - 42);

    approx(y.total_estimated_incomes, 1100);
    approx(y.total_estimated_expenses, 250);
    approx(y.total_estimated_expenses_vat, 52);
    approx(y.total_estimated_hours_price, 600);
    approx(y.estimated_incomes_expenses, 1100 - 250 - 600 - 52);

    approx(y.total_real_incomes, 900);
    approx(y.total_real_expenses, 180);
    approx(y.total_real_expenses_vat, 38);
    approx(y.total_real_hours_price, 450);
    approx(y.total_real_incomes_expenses, 900 - 180 - 450 - 38);

    approx(y.total_incomes, y.total_estimated_incomes);
    approx(y.total_expenses, y.total_estimated_expenses);
    approx(y.total_expenses_vat, y.total_estimated_expenses_vat);
    approx(y.incomes_expenses, y.estimated_incomes_expenses);
  });

  test('drops empty 9999 bucket', () => {
    const rows = [
      { year: '9999', income_orig: 0, expense_orig: 0 },
      { year: '2025', income_esti: 100 },
    ];
    const out = aggregateRowsByYear(rows);
    expect(out.length).toBe(1);
    expect(out[0].year).toBe('2025');
  });

  test('keeps 9999 bucket when it carries non-zero values', () => {
    const rows = [{ year: '9999', income_esti: 42 }];
    const out = aggregateRowsByYear(rows);
    expect(out.length).toBe(1);
    expect(out[0].year).toBe('9999');
    approx(out[0].total_estimated_incomes, 42);
  });

  test('handles periodification-style rows (negative expense values)', () => {
    const rows = [
      { year: '2025', expense_orig: -100, expense_esti: -100, expense_real: -100 },
      { year: '2025', expense_orig: -50, expense_esti: -50, expense_real: -50 },
    ];
    const [y] = aggregateRowsByYear(rows);
    approx(y.total_original_expenses, 150);
    approx(y.total_estimated_expenses, 150);
    approx(y.total_real_expenses, 150);
  });

  test('periodification affects estimated + real but NOT original', () => {
    const rows = [
      { year: '2025', type: 'income', income_orig: 0, income_esti: 1000, income_real: 800 },
      { year: '2025', type: 'expense', expense_orig: 0, expense_esti: -400, expense_real: -300 },
    ];
    const [y] = aggregateRowsByYear(rows);
    approx(y.total_original_incomes, 0);
    approx(y.total_original_expenses, 0);
    approx(y.total_estimated_incomes, 1000);
    approx(y.total_estimated_expenses, 400);
    approx(y.total_real_incomes, 800);
    approx(y.total_real_expenses, 300);
  });

  test('ignores undefined / null fields without producing NaN', () => {
    const rows = [
      { year: '2025', income_esti: null },
      { year: '2025', expense_esti: undefined },
      { year: '2025', income_esti: 10 },
    ];
    const [y] = aggregateRowsByYear(rows);
    approx(y.total_estimated_incomes, 10);
    approx(y.total_estimated_expenses, 0);
    expect(Number.isNaN(y.estimated_incomes_expenses)).toBe(false);
  });

  test('parses string numbers', () => {
    const rows = [{ year: '2025', income_esti: '100.50', expense_esti: '-25.25' }];
    const [y] = aggregateRowsByYear(rows);
    approx(y.total_estimated_incomes, 100.5);
    approx(y.total_estimated_expenses, 25.25);
  });
});
