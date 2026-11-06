'use strict';

/**
 * issues/416 (2026-11-06, Arran de Terra): Joel's 2026–27 jornada stored
 * 22.40 €/h while everyone with the same salary had 22.45. It was saved
 * before 2026 existed in «Anys», so the working-day modal used the 1764 h
 * fallback instead of the year's 1760 h. The API now computes a jornada's
 * cost per hour on every save, and re-prices the jornadas of a year when its
 * working hours are created or changed.
 */

const DEDICATION = 'api::daily-dedication.daily-dedication';
const YEAR = 'api::year.year';

let years;
let saved;
let others;
let updates;
let linesQueried;

function mockStrapi() {
  updates = [];
  linesQueried = [];
  global.strapi = {
    log: { info: jest.fn() },
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where }) => {
          if (uid === YEAR) return years.find((y) => y.year === where.year) || null;
          if (uid === DEDICATION) return saved;
          return null;
        }),
        findMany: jest.fn(async (args) => {
          if (uid === 'api::estimated-hour.estimated-hour') linesQueried.push(args.where);
          return uid === DEDICATION ? others : [];
        }),
        update: jest.fn(async ({ where, data }) => {
          updates.push({ uid, id: where.id, data });
          return { id: where.id, ...data };
        }),
      })),
    },
  };
}

beforeEach(() => {
  jest.resetModules();
  years = [{ year: 2026, working_hours: 1760 }];
  saved = null;
  others = [];
  mockStrapi();
});

afterEach(() => {
  delete global.strapi;
});

const JOEL = { monthly_salary: 3292.8, quota: 0, pct_quota: 0, from: '2026-01-01', to: '2027-12-31' };

describe('costByHourOf (issues/416)', () => {
  const { costByHourOf } = require('../src/services/dedication-cost');

  it('salary × 12 ÷ the year working hours, as the modal computes it', () => {
    expect(costByHourOf(JOEL, 1760)).toBe(22.45);
    expect(costByHourOf(JOEL, null)).toBe(22.4); // no year: the 1764 h fallback
  });

  it('adds the fixed quota and the % quota on the salary', () => {
    // Quim/Bruna: 2146.39 € + 33.52 % → 19.54 €/h with 1760 h
    expect(costByHourOf({ monthly_salary: 2146.39, quota: 0, pct_quota: 33.52 }, 1760)).toBe(19.54);
    expect(costByHourOf({ monthly_salary: 1000, quota: 100, pct_quota: 10 }, 1200)).toBe(12);
  });

  it('a jornada without salary keeps its cost (undefined)', () => {
    expect(costByHourOf({ monthly_salary: null }, 1760)).toBeUndefined();
    expect(costByHourOf({ monthly_salary: '' }, 1760)).toBeUndefined();
    expect(costByHourOf({ monthly_salary: 0 }, 1760)).toBe(0);
  });
});

describe('daily-dedication lifecycles derive costByHour (issues/416)', () => {
  const load = () => require('../src/api/daily-dedication/content-types/daily-dedication/lifecycles');

  it('a new jornada gets the cost of its year, whatever the form sent', async () => {
    const data = { ...JOEL, costByHour: 22.4, users_permissions_user: { set: [{ id: 24 }] } };
    await load().beforeCreate({ params: { data } });
    expect(data.costByHour).toBe(22.45);
  });

  it('an update re-derives it from the saved salary and the sent fields', async () => {
    saved = { id: 127, ...JOEL, costByHour: 22.4, users_permissions_user: { id: 24 } };
    const data = { hours: 7 };
    await load().beforeUpdate({ params: { data, where: { id: 127 } } });
    expect(data.costByHour).toBe(22.45);

    const raise = { monthly_salary: 3520 };
    await load().beforeUpdate({ params: { data: raise, where: { id: 127 } } });
    expect(raise.costByHour).toBe(24);
  });

  it("a partial update checks overlaps against the person's other periods", async () => {
    saved = { id: 127, ...JOEL, costByHour: 22.4, users_permissions_user: { id: 24 } };
    others = [{ id: 139, from: '2025-01-01', to: '2025-12-31' }];
    await expect(
      load().beforeUpdate({ params: { data: { from: '2025-06-01' }, where: { id: 127 } } }),
    ).rejects.toThrow(/overlaps/);
  });

  it("a partial update re-prices the person's lines in afterUpdate (the result has no person)", async () => {
    saved = { id: 127, ...JOEL, costByHour: 22.4, users_permissions_user: { id: 24 } };
    const lifecycles = load();
    const event = { params: { data: { hours: 8 }, where: { id: 127 } } };
    await lifecycles.beforeUpdate(event);
    event.result = { id: 127, hours: 8 };
    await lifecycles.afterUpdate(event);
    expect(linesQueried).toContainEqual({ users_permissions_user: 24 });
  });

  it('a jornada without salary is left as sent', async () => {
    const data = { from: '2025-01-01', to: '2025-12-31', hours: 6, monthly_salary: null, costByHour: null, users_permissions_user: 15 };
    await load().beforeCreate({ params: { data } });
    expect(data.costByHour).toBeNull();
  });
});

describe('year lifecycles re-price the jornadas of the year (issues/416)', () => {
  it('creating 2027 re-prices the 2027 jornadas saved with the fallback', async () => {
    others = [
      { id: 160, monthly_salary: 3292.8, quota: 0, pct_quota: 0, from: '2027-04-01', to: '2027-12-31', costByHour: 22.4 },
      { id: 161, monthly_salary: 3292.8, quota: 0, pct_quota: 0, from: '2027-01-01', to: '2027-03-31', costByHour: 22.45 },
      { id: 162, monthly_salary: null, from: '2027-01-01', to: '2027-12-31', costByHour: null },
    ];
    const lifecycles = require('../src/api/year/content-types/year/lifecycles');
    await lifecycles.afterCreate({ result: { year: 2027, working_hours: 1760 }, params: { data: {} } });
    expect(updates).toEqual([{ uid: DEDICATION, id: 160, data: { costByHour: 22.45 } }]);
  });

  it('an update that does not touch the working hours does nothing', async () => {
    others = [{ id: 160, monthly_salary: 3292.8, from: '2027-04-01', costByHour: 22.4 }];
    const lifecycles = require('../src/api/year/content-types/year/lifecycles');
    await lifecycles.afterUpdate({ result: { year: 2027, working_hours: 1760 }, params: { data: { deductible_vat_pct: 99 } } });
    expect(updates).toEqual([]);
    expect(global.strapi.db.query).not.toHaveBeenCalled();
  });

  it('changing the working hours re-prices with the new ones', async () => {
    others = [{ id: 127, monthly_salary: 3292.8, from: '2026-01-01', costByHour: 22.45 }];
    const lifecycles = require('../src/api/year/content-types/year/lifecycles');
    await lifecycles.afterUpdate({ result: { year: 2026, working_hours: 1764 }, params: { data: { working_hours: 1764 } } });
    expect(updates).toEqual([{ uid: DEDICATION, id: 127, data: { costByHour: 22.4 } }]);
  });
});


describe('rederiveFrom startup repair (issues/416)', () => {
  it('re-prices only the stale jornadas from the given day, once', async () => {
    years = [{ year: 2026, working_hours: 1760 }, { year: 2027, working_hours: 1760 }];
    others = [
      { id: 127, monthly_salary: 3292.8, quota: 0, pct_quota: 0, from: '2026-01-01', costByHour: 22.4 },
      { id: 160, monthly_salary: 3292.8, quota: 0, pct_quota: 0, from: '2027-04-01', costByHour: 22.4 },
      { id: 152, monthly_salary: 3292.8, quota: 0, pct_quota: 0, from: '2026-02-01', costByHour: 22.45 },
      { id: 162, monthly_salary: null, from: '2026-11-07', costByHour: null },
    ];
    const { rederiveFrom } = require('../src/services/dedication-cost');
    await expect(rederiveFrom('2026-01-01')).resolves.toBe(2);
    expect(updates).toEqual([
      { uid: DEDICATION, id: 127, data: { costByHour: 22.45 } },
      { uid: DEDICATION, id: 160, data: { costByHour: 22.45 } },
    ]);
  });
});
