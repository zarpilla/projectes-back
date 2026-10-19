'use strict';

/**
 * issues/194 (2026-10-19): budget lines stored quantity and price with 2
 * decimals while the form accepted more: a typed 0,0357 × 98.750 was stored as
 * 0,04 with total 3.525,38, Resum added up 3.950 and the next save rewrote the
 * total. Quantity and price keep 4 decimals now (DECIMAL(14,4)), the line total
 * is round2(quantity × price) everywhere, and a run-once repairs the stored
 * lines: the typed value when the total gives it back, else the total from
 * quantity × price (the user's call).
 */

const { lineTotal } = require('../src/services/budget-line');
const { budgetLineRepairs } = require('../src/services/repair-budget-line-totals');

describe('budget line total (issues/194)', () => {
  it('is quantity × price rounded to cents', () => {
    expect(lineTotal({ quantity: 0.0357, amount: 98750 })).toBe(3525.38);
    expect(lineTotal({ quantity: 2, amount: 1234.565 })).toBe(2469.13);
    expect(lineTotal({ quantity: '1.0000', amount: '32.4050' })).toBe(32.41);
    expect(lineTotal({ quantity: null, amount: 10 })).toBe(0);
  });
});

describe('repairBudgetLineTotals (issues/194)', () => {
  const repair = (row) => budgetLineRepairs([{ id: 1, ...row }]).map((r) => r.data);

  it('leaves lines that agree with their total alone', () => {
    expect(repair({ quantity: 3, amount: 10.5, total_amount: 31.5 })).toEqual([]);
    expect(repair({ quantity: 3, amount: 10.5, total_amount: null })).toEqual([]);
  });

  it('restores a quantity or price that was rounded to 2 decimals', () => {
    expect(repair({ quantity: 0.04, amount: 98750, total_amount: 3525.38 })).toEqual([{ quantity: 0.0357 }]);
    expect(repair({ quantity: 0.13, amount: 162114.21, total_amount: 20264.28 })).toEqual([{ quantity: 0.125 }]);
    expect(repair({ quantity: 2, amount: 1234.57, total_amount: 2469.13 })).toEqual([{ amount: 1234.565 }]);
    expect(repair({ quantity: 5, amount: 205.79, total_amount: 1028.93 })).toEqual([{ amount: 205.786 }]);
  });

  it('recomputes the total from quantity × price otherwise', () => {
    expect(repair({ quantity: 6, amount: 1000, total_amount: 10000 })).toEqual([{ total_amount: 6000 }]);
    expect(repair({ quantity: 1, amount: 0, total_amount: 200 })).toEqual([{ total_amount: 0 }]);
    // 0,9997 would give 32,40 too, but nobody typed it
    expect(repair({ quantity: 1, amount: 32.41, total_amount: 32.4 })).toEqual([{ total_amount: 32.41 }]);
  });
});

describe('widenBudgetLineDecimals (issues/194)', () => {
  let statements;

  function mockStrapi(client, scales) {
    statements = [];
    global.strapi = {
      log: { info: jest.fn() },
      db: {
        dialect: { client },
        metadata: { get: (uid) => ({ tableName: uid.includes('income') ? 'phase_incomes' : 'phase_expenses' }) },
        connection: {
          raw: jest.fn(async (sql, bindings) => {
            statements.push(sql.replace(/\s+/g, ' ').trim());
            if (sql.includes('information_schema')) return [[{ scale: scales[bindings.join('.')] }], []];
            return [{ affectedRows: 0 }, undefined];
          }),
        },
      },
    };
  }

  beforeEach(() => jest.resetModules());
  afterEach(() => {
    delete global.strapi;
  });

  it('widens only the columns with fewer than 4 decimals', async () => {
    mockStrapi('mysql', {
      'phase_incomes.quantity': 2,
      'phase_incomes.amount': 4,
      'phase_expenses.quantity': 2,
      'phase_expenses.amount': 2,
    });
    const { widenBudgetLineDecimals } = require('../src/services/widen-budget-line-decimals');
    await widenBudgetLineDecimals();

    expect(statements.filter((s) => s.startsWith('ALTER'))).toEqual([
      'ALTER TABLE `phase_incomes` MODIFY `quantity` DECIMAL(14,4) NULL',
      'ALTER TABLE `phase_expenses` MODIFY `quantity` DECIMAL(14,4) NULL',
      'ALTER TABLE `phase_expenses` MODIFY `amount` DECIMAL(14,4) NULL',
    ]);
  });

  it('does nothing outside MySQL', async () => {
    mockStrapi('sqlite', {});
    const { widenBudgetLineDecimals } = require('../src/services/widen-budget-line-decimals');
    await widenBudgetLineDecimals();
    expect(statements).toEqual([]);
  });
});
