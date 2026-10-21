'use strict';

/**
 * issues/309 (2026-10-21): treasuries/forecast built the plan's economic-detail
 * rows of every project (every project field on each) only to add three sums
 * per year — a third of a Tresoreria call served from the read cache.
 * buildEstimatedForecastByYear now adds them directly; it must give exactly,
 * bit for bit, what building the rows and aggregating them gave
 * (buildEstimatedForecastByYearFromRows, the previous code).
 *
 * Also: dates of years 0–99 (typos like «0026-05-01») keep their year, as with
 * moment; Date.UTC turned them into 1926.
 */

const {
  buildEstimatedForecastByYear,
  buildEstimatedForecastByYearFromRows,
  dayNumber,
  dayInfo,
} = require('../src/api/project/services/projectFinancials');

// seeded PRNG, so a failure can be reproduced
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(seed) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const date = () => pick([null, '', '2024-03-15', '2025-12-31', '2026-01-01', '2026-07-04', '2027-02-28', '0026-05-01', 'nope']);
  const amount = () => pick([0, 1, 12.34, 100, 999.99, -50, '25.5', null]);
  const doc = () => pick([null, undefined, { emitted: date() || '2026-02-02', total_vat: pick([undefined, null, 0, 21.5]) }]);
  const projects = [];
  for (let i = 0; i < 25; i++) {
    const phases = [];
    for (let f = 0; f < 3; f++) {
      const incomes = [];
      const expenses = [];
      for (let l = 0; l < 6; l++) {
        incomes.push({
          quantity: amount(),
          amount: amount(),
          discount: pick([undefined, 0, 10]),
          date: date(),
          date_estimate_document: pick([undefined, null, date()]),
          paid: r() < 0.4,
          invoice: doc(),
          income: pick([undefined, doc()]),
        });
        expenses.push({
          quantity: amount(),
          amount: amount(),
          date: date(),
          date_estimate_document: pick([undefined, null, date()]),
          vat_pct: pick([undefined, null, '', 0, 10, 21]),
          expense_type: pick([null, { vat_pct: 4 }, { vat_pct: null }]),
          paid: r() < 0.4,
          invoice: doc(),
          expense: pick([undefined, doc()]),
        });
      }
      phases.push({ incomes, expenses });
    }
    projects.push({
      id: i,
      date_start: pick([null, '2025-02-01', '2026-06-01']),
      date_end: pick([null, '2027-01-01']),
      project_phases: phases,
      periodification: r() < 0.5 ? [{ year: pick([2025, 2026, '2027']), incomes: amount(), expenses: amount(), real_incomes: amount(), real_expenses: amount() }] : [],
    });
  }
  return projects;
}

describe('forecast per year without building rows (issues/309)', () => {
  const vat = new Map([['2025', 80], ['2026', 97.42]]);

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('equals the rows aggregation, bit for bit (seed %i)', (seed) => {
    for (const periodification of ['no', 'prevista', 'real']) {
      const projects = generate(seed);
      expect(buildEstimatedForecastByYear(projects, vat, 90, periodification)).toEqual(
        buildEstimatedForecastByYearFromRows(generate(seed), vat, 90, periodification),
      );
    }
  });

  it('keeps an undated year with real amounts only, drops an empty one', () => {
    const paidUndated = {
      id: 1,
      project_phases: [{ incomes: [{ quantity: 1, amount: 100, date: '2026-01-01', paid: true, invoice: { emitted: 'nope' } }], expenses: [] }],
    };
    const zero = { id: 2, project_phases: [{ incomes: [{ quantity: 1, amount: 0 }], expenses: [] }] };
    for (const projects of [[paidUndated], [zero], [paidUndated, zero]]) {
      expect(buildEstimatedForecastByYear(projects, vat, 100)).toEqual(buildEstimatedForecastByYearFromRows(projects, vat, 100));
    }
  });
});

describe('day numbers of years 0–99 (issues/309)', () => {
  it('keep their year, as moment does', () => {
    expect(dayInfo(dayNumber('0026-05-01')).str).toBe('0026-05-01');
    expect(dayInfo(dayNumber('0099-12-31')).str).toBe('0099-12-31');
    expect(dayNumber('0026-02-30')).toBeNaN();
  });
});
