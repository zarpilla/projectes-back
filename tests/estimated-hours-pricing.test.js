'use strict';

/**
 * issues/416 (2026-11-06, Arran de Terra, ACTGI 24-27): planning lines kept
 * the €/h of the day they were saved (Joel 21.77, Ariadna 19.49, Bruna 18.23
 * while their jornadas said 22.45 / 19.54). A line's €/h is now what the
 * project engine says its hours cost with the person's jornadas (each working
 * day with the jornada covering it, festives out) ÷ its hours: a weighted
 * average when the line crosses a change of jornada. It's re-derived when the
 * line is saved and when the jornadas change (and then the person's projects
 * are marked for the totals cron), with a one-off backfill.
 */

jest.mock('../src/api/project/services/project-totals', () => ({ markDirty: jest.fn(async () => 0) }));

const DEDICATION = 'api::daily-dedication.daily-dedication';
const FESTIVE = 'api::festive.festive';
const PHASE_INCOME = 'api::phase-income.phase-income';

const person = { id: 15 };
// 20 €/h until June, 30 €/h from July, no salary in 2025
const DEDICATIONS = [
  { id: 1, from: '2026-01-01', to: '2026-06-30', costByHour: 20, users_permissions_user: person },
  { id: 2, from: '2026-07-01', to: '2026-12-31', costByHour: 30, users_permissions_user: person },
  { id: 3, from: '2025-01-01', to: '2025-12-31', costByHour: null, users_permissions_user: person },
];

let updates;
let estimatedWhere;
let markDirty;

function mockStrapi({ dedications = DEDICATIONS, festives = [], rows = [], incomes = [] } = {}) {
  updates = [];
  global.strapi = {
    log: { info: jest.fn(), warn: jest.fn() },
    db: {
      query: jest.fn((uid) => ({
        findMany: jest.fn(async (args) => {
          if (uid === DEDICATION) return dedications;
          if (uid === FESTIVE) return festives;
          if (uid === PHASE_INCOME) return incomes;
          estimatedWhere = args.where;
          return rows;
        }),
        update: jest.fn(async ({ where, data }) => {
          updates.push({ id: where.id, data });
          return { id: where.id, ...data };
        }),
      })),
    },
  };
}

let pricing;
beforeEach(() => {
  jest.resetModules();
  markDirty = require('../src/api/project/services/project-totals').markDirty;
  pricing = require('../src/services/estimated-hours-pricing');
  mockStrapi();
});

afterEach(() => {
  delete global.strapi;
});

// a «Total» line: `quantity` hours spread over the working days of the range
const line = (from, to, quantity = 10, extra = {}) => ({
  from,
  to,
  quantity,
  quantity_type: 'total',
  users_permissions_user: person,
  ...extra,
});

describe('rateForLine (issues/416)', () => {
  it('a line inside one jornada takes its rate', async () => {
    await expect(pricing.rateForLine(line('2026-02-02', '2026-03-31'), DEDICATIONS, [])).resolves.toBe(20);
    await expect(pricing.rateForLine(line('2026-09-01', '2026-12-31'), DEDICATIONS, [])).resolves.toBe(30);
  });

  it('a line crossing a change of jornada takes the weighted average of its days', async () => {
    // Mon 29 and Tue 30 June at 20, Wed 1 – Fri 3 July at 30: (2×20 + 3×30) / 5
    await expect(pricing.rateForLine(line('2026-06-29', '2026-07-03'), DEDICATIONS, [])).resolves.toBe(26);
  });

  it('festives are not working days', async () => {
    // 1 July off: 2 days at 20, 2 at 30
    const festives = [{ id: 9, date: '2026-07-01', users_permissions_user: null }];
    await expect(pricing.rateForLine(line('2026-06-29', '2026-07-03'), DEDICATIONS, festives)).resolves.toBe(25);
  });

  it('monthly lines are weighted too', async () => {
    const monthly = line('2026-06-01', '2026-07-31', 20, { quantity_type: 'month' });
    const rate = await pricing.rateForLine(monthly, DEDICATIONS, []);
    expect(rate).toBeGreaterThan(20);
    expect(rate).toBeLessThan(30);
  });

  it('is null when no jornada with a salary prices it', async () => {
    await expect(pricing.rateForLine(line('2025-02-03', '2025-06-30'), DEDICATIONS, [])).resolves.toBeNull();
    await expect(pricing.rateForLine(line('2028-01-03', '2028-06-30'), DEDICATIONS, [])).resolves.toBeNull();
    await expect(pricing.rateForLine(line(null, '2026-06-30'), DEDICATIONS, [])).resolves.toBeNull();
    await expect(pricing.rateForLine(line('2026-02-02', '2026-03-31', 10, { users_permissions_user: null }), DEDICATIONS, [])).resolves.toBeNull();
  });
});

describe('priceOfRow (issues/416)', () => {
  it('prices the line and its total as amount × quantity', async () => {
    const byUser = new Map([[15, DEDICATIONS]]);
    await expect(pricing.priceOfRow(line('2026-06-29', '2026-07-03', 98), byUser, [])).resolves.toEqual({
      amount: 26,
      total_amount: 2548,
    });
    await expect(pricing.priceOfRow(line('2025-02-03', '2025-06-30', 98), byUser, [])).resolves.toBeNull();
  });
});

describe('rederiveUser (issues/416)', () => {
  it("re-prices the person's stale lines and marks her projects for the totals cron", async () => {
    mockStrapi({
      rows: [
        // already right: not written
        { id: 101, amount: 20, total_amount: 200, ...line('2026-02-02', '2026-03-31'), phase_income: { id: 7 } },
        // saved at an old rate: re-priced
        { id: 102, amount: 19.49, total_amount: 194.9, ...line('2026-09-01', '2026-12-31'), phase_income: { id: 8 } },
        // no jornada prices it: kept
        { id: 103, amount: 19.49, total_amount: 194.9, ...line('2025-02-03', '2025-06-30'), phase_income: { id: 8 } },
      ],
      incomes: [
        { id: 7, project_phase: { project: { id: 40 } } },
        { id: 8, project_original_phase: { project: { id: 41 } } },
      ],
    });
    await expect(pricing.rederiveUser(15)).resolves.toBe(1);
    expect(estimatedWhere).toEqual({ users_permissions_user: 15 });
    expect(updates).toEqual([{ id: 102, data: { amount: 30, total_amount: 300 } }]);
    // both projects: the forecast prices her days with the jornadas, line moved or not
    expect(markDirty).toHaveBeenCalledWith([40, 41]);
  });

  it('marks nothing when she has no planning lines', async () => {
    mockStrapi({ rows: [] });
    await expect(pricing.rederiveUser(15)).resolves.toBe(0);
    expect(markDirty).not.toHaveBeenCalled();
  });
});

describe('rederiveRows (issues/416)', () => {
  it('fetches exactly the rows a project save wrote and re-prices them', async () => {
    mockStrapi({ rows: [{ id: 102, amount: 21.77, total_amount: 217.7, ...line('2026-06-29', '2026-07-03') }] });
    await expect(pricing.rederiveRows([102, 102, null])).resolves.toBe(1);
    expect(estimatedWhere).toEqual({ id: 102 });
    expect(updates).toEqual([{ id: 102, data: { amount: 26, total_amount: 260 } }]);
  });

  it('does nothing without rows', async () => {
    mockStrapi();
    await expect(pricing.rederiveRows([])).resolves.toBe(0);
    expect(global.strapi.db.query).not.toHaveBeenCalled();
  });
});
