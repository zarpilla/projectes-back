'use strict';

/**
 * issues/416 — a planning line's €/h is its person's working day covering the
 * line's period, re-derived when the line is saved and when the jornadas
 * change, with a one-off backfill for the lines saved at an old salary.
 */

const DEDICATION = 'api::daily-dedication.daily-dedication';
const ESTIMATED_HOUR = 'api::estimated-hour.estimated-hour';

// Ariadna's real arrandeterra jornadas: 2842 € until 2024-08, no salary in
// 2025, 3292.80 € (22.45 €/h) from 2026 on.
const DEDICATIONS = [
  { id: 1, from: '2023-01-01', to: '2024-08-31', costByHour: 19.49, users_permissions_user: { id: 15 } },
  { id: 2, from: '2025-01-01', to: '2025-12-31', costByHour: null, users_permissions_user: { id: 15 } },
  { id: 3, from: '2026-01-01', to: '2027-12-31', costByHour: 22.45, users_permissions_user: { id: 15 } },
];

let updates;
let estimatedWhere;
let dedicationWhere;

function mockStrapi({ dedications = DEDICATIONS, rows = [] } = {}) {
  updates = [];
  global.strapi = {
    log: { info: jest.fn() },
    db: {
      query: jest.fn((uid) => ({
        findMany: jest.fn(async (args) => {
          if (uid === DEDICATION) {
            dedicationWhere = args.where;
            return dedications;
          }
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

const { rateForLine, priceOfRow, rederiveRows, rederiveUser } = require('../src/services/estimated-hours-pricing');

describe('rateForLine (issues/416)', () => {
  it("takes the working day covering the line's first day", () => {
    expect(rateForLine(DEDICATIONS, '2024-05-02', '2024-07-31')).toBe(19.49);
    expect(rateForLine(DEDICATIONS, '2026-09-01', '2026-12-31')).toBe(22.45);
  });

  it('falls back to the first working day overlapping the period', () => {
    // the line starts before every jornada, but one overlaps it
    expect(rateForLine(DEDICATIONS, '2022-06-01', '2023-03-31')).toBe(19.49);
  });

  it('is null when no working day prices the period', () => {
    expect(rateForLine(DEDICATIONS, '2025-02-01', '2025-06-30')).toBeNull(); // jornada without cost
    expect(rateForLine(DEDICATIONS, '2028-01-01', '2028-06-30')).toBeNull(); // no jornada yet
    expect(rateForLine(DEDICATIONS, null, '2025-06-30')).toBeNull(); // no dates
    expect(rateForLine([], '2026-01-01', '2026-12-31')).toBeNull();
  });
});

describe('priceOfRow (issues/416)', () => {
  const byUser = new Map([[15, DEDICATIONS]]);

  it('prices the line and its total as amount × quantity', () => {
    expect(priceOfRow({ quantity: 98, from: '2026-01-01', to: '2026-07-31', users_permissions_user: { id: 15 } }, byUser)).toEqual({
      amount: 22.45,
      total_amount: 2200.1,
    });
  });

  it('keeps the line (null) when nobody prices it', () => {
    expect(priceOfRow({ quantity: 98, from: '2025-01-01', to: '2025-07-31', users_permissions_user: { id: 15 } }, byUser)).toBeNull();
    expect(priceOfRow({ quantity: 98, from: '2026-01-01', to: '2026-07-31' }, byUser)).toBeNull(); // no person
  });
});

describe('rederiveUser (issues/416)', () => {
  it("re-prices the person's lines whose rate changed and leaves the rest", async () => {
    mockStrapi({
      rows: [
        // 2023 line kept at 19.49: already right, not written
        { id: 101, quantity: 98, amount: 19.49, total_amount: 1910.02, from: '2023-01-01', to: '2023-07-31', users_permissions_user: { id: 15 } },
        // 2027 line saved in 2024 at the then salary: re-priced
        { id: 102, quantity: 98, amount: 19.49, total_amount: 1910.02, from: '2027-01-01', to: '2027-07-31', users_permissions_user: { id: 15 } },
        // 2025 line: no jornada prices it, keeps its amount
        { id: 103, quantity: 20, amount: 19.49, total_amount: 389.8, from: '2025-01-01', to: '2025-06-30', users_permissions_user: { id: 15 } },
      ],
    });
    await expect(rederiveUser(15)).resolves.toBe(1);
    expect(estimatedWhere).toEqual({ users_permissions_user: 15 });
    expect(updates).toEqual([{ id: 102, data: { amount: 22.45, total_amount: 2200.1 } }]);
  });

  it('writes nothing when every line is already priced', async () => {
    mockStrapi({
      rows: [
        { id: 101, quantity: 98, amount: 19.49, total_amount: 1910.02, from: '2023-01-01', to: '2023-07-31', users_permissions_user: { id: 15 } },
      ],
    });
    await expect(rederiveUser(15)).resolves.toBe(0);
    expect(updates).toEqual([]);
  });
});

describe('rederiveRows (issues/416)', () => {
  it('fetches exactly the rows a project save wrote and re-prices them', async () => {
    mockStrapi({
      rows: [
        { id: 102, quantity: 17.5, amount: 21.77, total_amount: 380.98, from: '2026-09-01', to: '2026-12-31', users_permissions_user: { id: 15 } },
      ],
    });
    await expect(rederiveRows([102, 102, null])).resolves.toBe(1);
    expect(estimatedWhere).toEqual({ id: 102 });
    expect(updates).toEqual([{ id: 102, data: { amount: 22.45, total_amount: 392.88 } }]);
    expect(dedicationWhere).toEqual({ users_permissions_user: 15 });
  });

  it('does nothing without rows', async () => {
    mockStrapi();
    await expect(rederiveRows([])).resolves.toBe(0);
    expect(global.strapi.db.query).not.toHaveBeenCalled();
  });
});
