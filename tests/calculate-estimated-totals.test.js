'use strict';

/**
 * calculateEstimatedTotals walks a project's phases and turns their income
 * lines, expense lines and planned hours into the totals of the budget
 * ("Hores previstes", "Ingressos", "Despeses") and their split by year and day.
 *
 * Two kinds of test:
 *   - readable examples of each rule (how planned hours are spread, which days
 *     count, which year a line belongs to);
 *   - a recorded dataset: 150 generated projects whose results must stay
 *     bit-for-bit identical (same floating-point operation order), like the
 *     front's documentTotals / projectTreasury specs. After an intended change,
 *     review the diff and update with `npm test -- -u tests/calculate-estimated-totals.test.js`.
 */
const moment = require('moment');
const { calculateEstimatedTotals } = require('../src/api/project/services/projectFinancials');

const USER = { id: 7 };
const OTHER = { id: 8 };
// 20 €/h for all of 2026, 25 €/h for 2027
const DEDICATIONS = [
  { users_permissions_user: USER, from: '2026-01-01', to: '2026-12-31', costByHour: 20 },
  { users_permissions_user: USER, from: '2027-01-01', to: '2027-12-31', costByHour: 25 },
];

const project = (extra = {}) => ({ id: 1, name: 'P', date_start: '2026-01-01', ...extra });
const phaseWithHours = (hours) => [{ incomes: [{ quantity: 1, amount: 0, estimated_hours: [hours] }] }];
// totalsByYear is a lodash chain (callers iterate it, once): unwrap it
const byYear = (result) => Object.fromEntries(result.totalsByYear.value().map((y) => [y.year, y]));

describe('planned hours', () => {
  it('spreads a monthly amount over the working days: quantity / 5 / 4.3 a day', async () => {
    // Monday 2 to Monday 9 March 2026 (the last day is not counted): 5 working days
    const hours = {
      from: '2026-03-02',
      to: '2026-03-09',
      quantity: 43,
      quantity_type: 'month',
      users_permissions_user: USER,
    };
    const result = await calculateEstimatedTotals(project(), phaseWithHours(hours), DEDICATIONS, [], false);

    expect(result.total_estimated_hours).toBeCloseTo(10, 9);
    expect(result.total_estimated_hours_price).toBeCloseTo(200, 9);
    expect(result.totalsByDay.map((d) => d.day.format('YYYY-MM-DD'))).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
    ]);
    expect(hours.total_amount).toBeCloseTo(200, 9);
  });

  it('spreads a weekly amount over the working days: quantity / 5 a day', async () => {
    const hours = {
      from: '2026-03-02',
      to: '2026-03-16',
      quantity: 10,
      quantity_type: 'week',
      users_permissions_user: USER,
    };
    const result = await calculateEstimatedTotals(project(), phaseWithHours(hours), DEDICATIONS, [], false);

    expect(result.totalsByDay).toHaveLength(10);
    expect(result.total_estimated_hours).toBe(20);
    expect(result.total_estimated_hours_price).toBe(400);
  });

  it("skips festives: everybody's, and the personal ones of that user only", async () => {
    const hours = {
      from: '2026-03-02',
      to: '2026-03-09',
      quantity: 10,
      quantity_type: 'week',
      users_permissions_user: USER,
    };
    const festives = [
      { date: '2026-03-03' }, // everybody's
      { date: '2026-03-04', users_permissions_user: USER }, // this user's holiday
      { date: '2026-03-05', users_permissions_user: OTHER }, // somebody else's
    ];
    const result = await calculateEstimatedTotals(
      project(),
      phaseWithHours(hours),
      DEDICATIONS,
      festives,
      false,
    );

    expect(result.totalsByDay.map((d) => d.day.format('YYYY-MM-DD'))).toEqual([
      '2026-03-02',
      '2026-03-05',
      '2026-03-06',
    ]);
    expect(result.total_estimated_hours).toBe(6);
  });

  it('prices each day with the work period that covers it, 0 when there is none', async () => {
    // Wednesday 30 December 2026 to Wednesday 6 January 2027: 2 days at 20 €, 3 at 25 €
    const hours = {
      from: '2026-12-30',
      to: '2027-01-06',
      quantity: 5,
      quantity_type: 'week',
      users_permissions_user: USER,
    };
    const result = await calculateEstimatedTotals(project(), phaseWithHours(hours), DEDICATIONS, [], false);

    expect(result.total_estimated_hours_price).toBe(2 * 20 + 3 * 25);
    expect(byYear(result)['2026']).toMatchObject({
      total_estimated_hours: 2,
      total_estimated_hours_price: 40,
    });
    expect(byYear(result)['2027']).toMatchObject({
      total_estimated_hours: 3,
      total_estimated_hours_price: 75,
    });

    const unpriced = await calculateEstimatedTotals(project(), phaseWithHours({ ...hours }), [], [], false);
    expect(unpriced.total_estimated_hours).toBe(5);
    expect(unpriced.total_estimated_hours_price).toBe(0);
  });

  it('takes a total amount as it is, priced at its first day and split evenly over its working days', async () => {
    // Monday 22 December 2025 to Friday 9 January 2026, both included: 15
    // weekdays, 25 and 26 December and 1 January are festive, so 12 count,
    // 6 in 2025 and 6 in 2026: 2 h each.
    const hours = { from: '2025-12-22', to: '2026-01-09', quantity: 24, users_permissions_user: USER };
    const dedications = [
      { users_permissions_user: USER, from: '2025-01-01', to: '2025-12-31', costByHour: 10 },
    ];
    const festives = [{ date: '2025-12-25' }, { date: '2025-12-26' }, { date: '2026-01-01' }];
    const result = await calculateEstimatedTotals(project(), phaseWithHours(hours), dedications, festives, false);

    expect(result.total_estimated_hours).toBe(24);
    expect(result.total_estimated_hours_price).toBe(240);
    const days = result.totalsByDay.map((d) => d.day.format('YYYY-MM-DD'));
    expect(days).toEqual([
      '2025-12-22', '2025-12-23', '2025-12-24', '2025-12-29', '2025-12-30', '2025-12-31',
      '2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09',
    ]);
    expect(result.totalsByDay.every((d) => d.q === 2 && d.costByHour === 10)).toBe(true);
    expect(byYear(result)['2025']).toMatchObject({ total_estimated_hours: 12, total_estimated_hours_price: 120 });
    expect(byYear(result)['2026']).toMatchObject({ total_estimated_hours: 12, total_estimated_hours_price: 120 });
  });

  it('keeps a short total amount in the per-day rows (issues/259)', async () => {
    // Review 8 (2026-10-20), Arran de Terra «Jordania»: two 56 h «Total» lines
    // for 10–16 Nov 2025 produced no per-day rows (the range rounded to 0
    // months), so 112 h and their cost vanished from the stored totals.
    const hours = { from: '2026-11-09', to: '2026-11-15', quantity: 56, users_permissions_user: USER };
    const result = await calculateEstimatedTotals(project(), phaseWithHours(hours), DEDICATIONS, [], false);

    expect(result.totalsByDay).toHaveLength(5); // Monday to Friday
    expect(result.totalsByDay.reduce((sum, d) => sum + d.q, 0)).toBe(56);
    expect(byYear(result)['2026']).toMatchObject({ total_estimated_hours: 56, total_estimated_hours_price: 1120 });
  });

  it('keeps a one-day total and a weekend-only total in the per-day rows (issues/259)', async () => {
    const oneDay = await calculateEstimatedTotals(
      project(),
      phaseWithHours({ from: '2026-03-04', to: '2026-03-04', quantity: 6, users_permissions_user: USER }),
      DEDICATIONS,
      [],
      false,
    );
    expect(oneDay.totalsByDay.map((d) => [d.day.format('YYYY-MM-DD'), d.q])).toEqual([['2026-03-04', 6]]);

    // Saturday and Sunday: no working day, the calendar days take the hours
    const weekend = await calculateEstimatedTotals(
      project(),
      phaseWithHours({ from: '2026-03-07', to: '2026-03-08', quantity: 6, users_permissions_user: USER }),
      DEDICATIONS,
      [],
      false,
    );
    expect(weekend.totalsByDay.map((d) => [d.day.format('YYYY-MM-DD'), d.q])).toEqual([
      ['2026-03-07', 3],
      ['2026-03-08', 3],
    ]);
  });

  it('ignores hours without dates or without a person', async () => {
    const phases = [
      {
        incomes: [
          {
            quantity: 1,
            amount: 0,
            estimated_hours: [
              { quantity: 10, quantity_type: 'week', users_permissions_user: USER },
              { from: '2026-03-02', to: '2026-03-09', quantity: 10, quantity_type: 'week' },
            ],
          },
        ],
      },
    ];
    const result = await calculateEstimatedTotals(project(), phases, DEDICATIONS, [], false);

    expect(result.total_estimated_hours).toBe(0);
    expect(result.totalsByDay).toEqual([]);
  });
});

describe('income and expense lines', () => {
  const phases = () => [
    {
      incomes: [
        { quantity: 2, amount: 500, date: '2026-05-10' },
        // the forecast date wins over the date
        { quantity: 1, amount: 300, date: '2026-05-10', date_estimate_document: '2027-01-15' },
        // no date: the year the project starts
        { quantity: 1, amount: 50 },
        { quantity: 1, amount: 200, date: '2026-06-01', paid: true, invoice: { emitted: '2027-02-01' } },
      ],
      expenses: [
        { quantity: 3, amount: 100, date: '2026-07-01', expense_type: { vat_pct: 10 } },
        // no expense type: 21 % VAT
        { quantity: 1, amount: 100, date: '2026-07-01' },
        {
          quantity: 1,
          amount: 400,
          date: '2026-08-01',
          paid: true,
          expense_type: { vat_pct: 21 },
          invoice: { emitted: '2026-09-01', total_vat: 80 },
        },
        // paid with a ticket instead of an invoice: its own VAT
        { quantity: 1, amount: 100, date: '2026-08-01', paid: true, expense: { emitted: '2028-01-01' } },
      ],
    },
  ];

  it('adds quantity × amount, and VAT by the expense type', async () => {
    const result = await calculateEstimatedTotals(project(), phases(), [], [], false);

    expect(result.total_incomes).toBe(1000 + 300 + 50 + 200);
    expect(result.total_expenses).toBe(300 + 100 + 400 + 100);
    expect(result.total_expenses_vat).toBe(30 + 21 + 84 + 21);
    expect(result.total_real_incomes).toBe(200);
    expect(result.total_real_expenses).toBe(500);
  });

  it('puts each line in the year of its forecast date, its date, or the project start', async () => {
    const years = byYear(await calculateEstimatedTotals(project(), phases(), [], [], false));

    expect(Object.keys(years).sort()).toEqual(['2026', '2027']);
    expect(years['2026']).toMatchObject({
      total_incomes: 1250,
      total_expenses: 900,
      total_expenses_vat: 156,
    });
    expect(years['2027'].total_incomes).toBe(300);
    // paid lines only get their year when the real dimension is asked for
    expect(years['2026'].total_real_incomes || 0).toBe(0);
    expect(years['2026'].total_real_expenses || 0).toBe(0);
  });

  it('dates paid lines by their document when the real dimension is asked for', async () => {
    const result = await calculateEstimatedTotals(project(), phases(), [], [], true);
    const years = byYear(result);

    expect(years['2027'].total_real_incomes).toBe(200);
    expect(years['2026']).toMatchObject({ total_real_expenses: 400, total_real_expenses_vat: 80 });
    expect(years['2028']).toMatchObject({ total_real_expenses: 100, total_real_expenses_vat: 21 });
    // the invoice's VAT (80), not the 21 % of the line (84)
    expect(result.total_real_expenses_vat).toBe(80 + 21);
  });

  it('is all zeros for a project without phases', async () => {
    for (const phases of [undefined, null, []]) {
      const result = await calculateEstimatedTotals(project(), phases, DEDICATIONS, [], true);
      expect(result).toMatchObject({
        total_incomes: 0,
        total_expenses: 0,
        total_expenses_vat: 0,
        total_estimated_hours: 0,
        total_estimated_hours_price: 0,
        total_real_incomes: 0,
        total_real_expenses: 0,
        total_real_expenses_vat: 0,
        totalsByDay: [],
      });
      expect(result.totalsByYear.value()).toEqual([]);
    }
  });
});

// --- recorded dataset -------------------------------------------------------------

// small deterministic PRNG (mulberry32), so the dataset is the same everywhere
function prng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dataset() {
  const rnd = prng(20261012);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
  const iso = (m) => m.format('YYYY-MM-DD');
  // Noon UTC keeps the calendar day the same in any time zone the suite runs in.
  const day = () => iso(moment.utc('2025-01-01T12:00:00Z').add(int(0, 1094), 'days'));
  const users = [{ id: 1 }, { id: 2 }, { id: 3 }];

  const dailyDedications = [];
  for (const user of users) {
    for (const year of [2025, 2026, 2027]) {
      if (rnd() < 0.15) continue; // a year without a work period: hours at 0 €
      dailyDedications.push({
        users_permissions_user: user,
        from: `${year}-01-01`,
        to: `${year}-12-31`,
        costByHour: Math.round(rnd() * 3000) / 100 + 10,
      });
    }
  }
  const festives = [];
  for (let i = 0; i < 60; i++) {
    festives.push(rnd() < 0.5 ? { date: day() } : { date: day(), users_permissions_user: pick(users) });
  }

  const document = () => pick([undefined, { emitted: day() }, { paid_date: day() }, { date: day() }, {}]);
  const hours = () => {
    const from = moment.utc(`${day()}T12:00:00Z`);
    const quantity_type = pick(['month', 'week', undefined, null]);
    // whole months for the totals split by month, a few weeks for the daily ones
    const to = quantity_type ? from.clone().add(int(1, 60), 'days') : from.clone().add(int(1, 14), 'months');
    return {
      from: rnd() < 0.05 ? null : iso(from),
      to: iso(to),
      quantity: pick([1, 4, 8, 10, 20, 37.5, 160]),
      quantity_type,
      users_permissions_user: rnd() < 0.05 ? null : pick(users),
    };
  };
  const line = () => ({
    quantity: pick([1, 2, 3, 0.5, 12, 0, undefined]),
    amount: pick([undefined, 0, Math.round(rnd() * 500000) / 100]),
    date: pick([undefined, null, day()]),
    date_estimate_document: rnd() < 0.3 ? day() : undefined,
    paid: rnd() < 0.4,
  });

  const projects = [];
  for (let p = 0; p < 150; p++) {
    const phases = [];
    for (let i = int(0, 3); i > 0; i--) {
      const incomes = [];
      for (let j = int(0, 4); j > 0; j--) {
        const income = { ...line(), invoice: document(), income: rnd() < 0.2 ? document() : undefined };
        if (rnd() < 0.6) income.estimated_hours = Array.from({ length: int(0, 3) }, hours);
        incomes.push(income);
      }
      const expenses = [];
      for (let j = int(0, 4); j > 0; j--) {
        const invoice = document();
        expenses.push({
          ...line(),
          expense_type: pick([undefined, {}, { vat_pct: 4 }, { vat_pct: 10 }, { vat_pct: 21 }]),
          invoice:
            invoice && rnd() < 0.7 ? { ...invoice, total_vat: Math.round(rnd() * 20000) / 100 } : invoice,
          expense: document(),
        });
      }
      phases.push({ incomes, expenses });
    }
    projects.push({
      data: {
        id: p + 1,
        name: `Project ${p + 1}`,
        date_start: pick([undefined, null, day()]),
        date_end: day(),
      },
      phases,
      real: rnd() < 0.5,
    });
  }
  return { projects, dailyDedications, festives };
}

// What a result says, without the echoed input or the moment objects
const recorded = (result) => {
  const { data: _data, totalsByDay, totalsByYear, ...totals } = result;
  return {
    ...totals,
    days: totalsByDay.length,
    daysHours: totalsByDay.reduce((sum, d) => sum + d.q, 0),
    daysCost: totalsByDay.reduce((sum, d) => sum + d.q * d.costByHour, 0),
    firstDay: totalsByDay.length ? totalsByDay[0].day.format('YYYY-MM-DD') : null,
    totalsByYear: totalsByYear.value().sort((a, b) => a.year.localeCompare(b.year)),
  };
};

describe('recorded dataset', () => {
  it('matches the recorded totals of 150 generated projects exactly', async () => {
    const { projects, dailyDedications, festives } = dataset();
    const results = [];
    for (const { data, phases, real } of projects) {
      results.push(recorded(await calculateEstimatedTotals(data, phases, dailyDedications, festives, real)));
    }
    // the dataset does exercise the engine: hours, incomes and expenses are there
    expect(results.filter((r) => r.total_estimated_hours > 0).length).toBeGreaterThan(50);
    expect(results.filter((r) => r.total_real_expenses_vat > 0).length).toBeGreaterThan(20);
    expect(results).toMatchSnapshot();
  });

  it('writes the totals of each line back on the phases, as the form reads them', async () => {
    const { projects, dailyDedications, festives } = dataset();
    const written = [];
    for (const { data, phases, real } of projects.slice(0, 40)) {
      await calculateEstimatedTotals(data, phases, dailyDedications, festives, real);
      for (const phase of phases) {
        for (const income of phase.incomes) {
          written.push([
            income.total_amount,
            income.total_estimated_hours,
            ...(income.estimated_hours || []).map((h) => h.total_amount),
          ]);
        }
        for (const expense of phase.expenses)
          written.push([expense.total_amount, expense.total_expenses_vat]);
      }
    }
    expect(written).toMatchSnapshot();
  });
});
