'use strict';

/**
 * issues/371 (2026-10-30): a project can be billed per project («Projecte», as
 * until now) or by the hour («Hores»). In «Hores» the forecast income lines
 * with estimated hours are priced as hours × the project's price/hour, stored
 * on the line so every report keeps summing lineTotal(line). New projects take
 * the mode from Configuració (me.options.default_billing_mode).
 */

const {
  effectiveBillingMode,
  weekdaysBetween,
  hoursOfLine,
  hoursPricing,
  priceHoursLines,
  rowPrice,
  billedHours,
} = require('../src/services/hours-billing');

describe('hours billing pricing (issues/371)', () => {
  it('a project without mode is billed per project', () => {
    expect(effectiveBillingMode(undefined)).toBe('project');
    expect(effectiveBillingMode(null)).toBe('project');
    expect(effectiveBillingMode('hours')).toBe('hours');
  });

  it('counts weekdays, both ends included', () => {
    // 2026-11-02 is a Monday
    expect(weekdaysBetween('2026-11-02', '2026-11-08')).toBe(5);
    expect(weekdaysBetween('2026-11-02', '2026-11-15')).toBe(10);
    expect(weekdaysBetween('2026-11-08', '2026-11-02')).toBe(0);
    expect(weekdaysBetween(null, '2026-11-02')).toBe(0);
  });

  it('adds up total, weekly and monthly rows', () => {
    const line = {
      estimated_hours: [
        { quantity: 20, quantity_type: 'total' },
        { quantity: 10, quantity_type: 'week', from: '2026-11-02', to: '2026-11-15' }, // 2 weeks
        { quantity: 43, quantity_type: 'month', from: '2026-11-02', to: '2026-11-06' }, // 5 days of 43/21.5
      ],
    };
    expect(hoursOfLine(line)).toBe(20 + 20 + 10);
  });

  it('prices a line with hours in «Hores» only', () => {
    const line = { quantity: 1, amount: 900, estimated_hours: [{ quantity: 12.5 }] };
    expect(hoursPricing(line, 'hours', 45)).toEqual({ quantity: 12.5, amount: 45, total_amount: 562.5 });
    expect(hoursPricing(line, 'project', 45)).toBe(null);
    expect(hoursPricing(line, null, 45)).toBe(null);
  });

  it('leaves an invoiced or collected line with its amount', () => {
    const hours = [{ quantity: 10 }];
    expect(hoursPricing({ quantity: 1, amount: 900, paid: true, estimated_hours: hours }, 'hours', 45)).toBe(null);
    expect(hoursPricing({ quantity: 1, amount: 900, invoice: { id: 4 }, estimated_hours: hours }, 'hours', 45)).toBe(null);
    expect(hoursPricing({ quantity: 1, amount: 900, income: 6, estimated_hours: hours }, 'hours', 45)).toBe(null);
    expect(hoursPricing({ quantity: 1, amount: 900, invoice: null, estimated_hours: hours }, 'hours', 45)).not.toBe(null);
  });

  it('leaves lines without estimated hours as typed', () => {
    expect(hoursPricing({ quantity: 1, amount: 300, estimated_hours: [] }, 'hours', 45)).toBe(null);
    expect(hoursPricing({ quantity: 1, amount: 300 }, 'hours', 45)).toBe(null);
  });

  // issues/421: a planning row can carry its own price/hour; empty = the project's
  describe('own price per planning row (issues/421)', () => {
    it('an empty price follows the project, a set one wins (0 too)', () => {
      expect(rowPrice({ price: null }, 40)).toBe(40);
      expect(rowPrice({ price: '' }, 40)).toBe(40);
      expect(rowPrice({}, 40)).toBe(40);
      expect(rowPrice({ price: '55.5' }, 40)).toBe(55.5);
      expect(rowPrice({ price: 0 }, 40)).toBe(0);
    });

    it('prices the line as the sum of hours × each row price', () => {
      const line = { quantity: 1, amount: 0, estimated_hours: [{ quantity: 10, price: 60 }, { quantity: 10, price: null }] };
      expect(hoursPricing(line, 'hours', 40)).toEqual({ quantity: 20, amount: 50, total_amount: 1000 });
    });

    it('keeps the amount at 4 decimals', () => {
      const line = { estimated_hours: [{ quantity: 1, price: 10 }, { quantity: 2, price: 20 }] };
      // (10 + 40) / 3 = 16.6667 a hour
      expect(hoursPricing(line, 'hours', 0)).toEqual({ quantity: 3, amount: 16.6667, total_amount: 50 });
    });

    it('a line with no hours yet takes the project price', () => {
      const line = { estimated_hours: [{ quantity: 0, price: 70 }] };
      expect(hoursPricing(line, 'hours', 40)).toEqual({ quantity: 0, amount: 40, total_amount: 0 });
    });

    it('priceHoursLines reads the row prices', async () => {
      const update = jest.fn();
      let asked;
      global.strapi = {
        db: {
          query: () => ({
            findMany: async (q) => {
              asked = q;
              return [{ id: 4, quantity: 10, amount: 40, total_amount: 400, estimated_hours: [{ quantity: 10, price: 45 }] }];
            },
            update,
          }),
        },
      };
      expect(await priceHoursLines(7, { mode: 'hours', pricePerHour: 40 })).toBe(1);
      expect(asked.populate.estimated_hours.select).toContain('price');
      expect(update).toHaveBeenCalledWith({ where: { id: 4 }, data: { quantity: 10, amount: 45, total_amount: 450 } });
      delete global.strapi;
    });
  });

  describe('priceHoursLines', () => {
    let update;
    beforeEach(() => {
      update = jest.fn();
      global.strapi = {
        db: {
          query: () => ({
            findMany: async () => [
              { id: 1, quantity: 1, amount: 900, total_amount: 900, estimated_hours: [{ quantity: 10 }] },
              { id: 2, quantity: 10, amount: 40, total_amount: 400, estimated_hours: [{ quantity: 10 }] },
              { id: 3, quantity: 1, amount: 120, total_amount: 120, estimated_hours: [] },
            ],
            update,
          }),
        },
      };
    });
    afterEach(() => delete global.strapi);

    it('writes only the lines whose figures change', async () => {
      expect(await priceHoursLines(7, { mode: 'hours', pricePerHour: '40' })).toBe(1);
      expect(update).toHaveBeenCalledWith({ where: { id: 1 }, data: { quantity: 10, amount: 40, total_amount: 400 } });
    });

    it('does nothing for a project billed per project', async () => {
      expect(await priceHoursLines(7, { mode: 'project', pricePerHour: 40 })).toBe(0);
      expect(update).not.toHaveBeenCalled();
    });
  });
});

describe('project controller and billing mode (issues/371)', () => {
  let controller;
  let superUpdate;
  let superCreate;
  let incomeUpdate;
  let options;

  beforeEach(() => {
    jest.resetModules();
    superUpdate = jest.fn(async () => ({ data: { id: 5 } }));
    superCreate = jest.fn(async () => ({ data: { id: 6 } }));
    jest.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (_uid, build) =>
          Object.setPrototypeOf(build({ strapi: global.strapi }), { update: superUpdate, create: superCreate }),
      },
    }));
    incomeUpdate = jest.fn();
    options = { default_billing_mode: 'hours' };
    global.strapi = {
      contentType: () => ({ attributes: {} }),
      documents: () => ({ findFirst: async () => ({ options }) }),
      db: {
        transaction: async (fn) => fn(),
        query: (uid) =>
          uid === 'api::project.project'
            ? { findOne: async () => ({ id: 5, billing_mode: 'hours', invoice_hours_price: 50 }) }
            : {
                findMany: async () => [{ id: 9, quantity: 1, amount: 0, total_amount: 0, estimated_hours: [{ quantity: 8 }] }],
                update: incomeUpdate,
              },
      },
    };
    controller = require('../src/api/project/controllers/project');
  });

  afterEach(() => {
    delete global.strapi;
    jest.dontMock('@strapi/strapi');
  });

  const ctx = (data) => ({ params: { id: '5' }, query: {}, state: {}, request: { body: { data } }, badRequest: jest.fn() });

  it('a new project takes the default mode of Configuració', async () => {
    const c = ctx({ name: 'P' });
    await controller.create(c);
    expect(c.request.body.data.billing_mode).toBe('hours');
    options = {};
    const c2 = ctx({ name: 'P' });
    await controller.create(c2);
    expect(c2.request.body.data.billing_mode).toBe('project');
  });

  it('keeps a mode the form chose', async () => {
    const c = ctx({ name: 'P', billing_mode: 'project' });
    await controller.create(c);
    expect(c.request.body.data.billing_mode).toBe('project');
  });

  it('changing the price/hour reprices the hour lines before the totals', async () => {
    await controller.update(ctx({ invoice_hours_price: 60 }));
    expect(incomeUpdate).toHaveBeenCalledWith({ where: { id: 9 }, data: { quantity: 8, amount: 60, total_amount: 480 } });
    expect(superUpdate).toHaveBeenCalled();
    expect(incomeUpdate.mock.invocationCallOrder[0]).toBeLessThan(superUpdate.mock.invocationCallOrder[0]);
  });

  it('switching to «Projecte» leaves the lines alone', async () => {
    await controller.update(ctx({ billing_mode: 'project' }));
    expect(incomeUpdate).not.toHaveBeenCalled();
  });

  it('a save that touches neither phases nor billing does not query the lines', async () => {
    await controller.update(ctx({ name: 'P-1' }));
    expect(incomeUpdate).not.toHaveBeenCalled();
  });
});

// issues/421: the billing price of a planning row is a finance figure, like its cost
describe('planning row price for a user without full access (issues/421)', () => {
  it('is dropped with the amounts', () => {
    const { rulesFor } = require('../src/services/response-sanitizer');
    const rule = rulesFor({ selfId: 3, permissions: ['projects'] })['api::estimated-hour.estimated-hour'];
    expect(rule.drop).toEqual(expect.arrayContaining(['amount', 'total_amount', 'price']));
  });
});

// issues/421 «Per facturar»: the hours worked, priced at the planning line of
// the same person covering the day, else at the project price
describe('billedHours (issues/421)', () => {
  const phases = [
    {
      incomes: [
        {
          estimated_hours: [
            { users_permissions_user: { id: 1 }, from: '2026-01-01', to: '2026-06-30', price: 60 },
            { users_permissions_user: { id: 1 }, from: '2026-07-01', to: '2026-12-31', price: null },
            { users_permissions_user: 2, from: '2026-01-01', to: '2026-12-31', price: '70' },
          ],
        },
      ],
    },
  ];
  const yearOf = (day) => (day ? day.slice(0, 4) : '9999');

  it('prices each activity at the covering row of its person, else the project price', () => {
    const activities = [
      { date: '2026-03-02', hours: 10, users_permissions_user: { id: 1 } }, // 60
      { date: '2026-08-03', hours: 10, users_permissions_user: { id: 1 } }, // row without price → 40
      { date: '2026-05-04', hours: 2, users_permissions_user: { id: 2 } }, // 70
      { date: '2026-05-04', hours: 5, users_permissions_user: { id: 3 } }, // no row → 40
      { date: '2027-01-04', hours: 1, users_permissions_user: { id: 1 } }, // outside → 40
    ];
    expect(billedHours({ activities, phases, pricePerHour: 40, yearOf })).toEqual({
      total: 600 + 400 + 140 + 200 + 40,
      byYear: { 2026: 1340, 2027: 40 },
    });
  });

  it('undated or person-less activities take the project price; no hours bill nothing', () => {
    const activities = [
      { date: null, hours: 2, users_permissions_user: { id: 1 } },
      { date: new Date('2026-03-02T00:00:00Z'), hours: 1, users_permissions_user: null },
      { date: '2026-03-02', hours: 0, users_permissions_user: { id: 1 } },
    ];
    expect(billedHours({ activities, phases, pricePerHour: 40, yearOf })).toEqual({
      total: 120,
      byYear: { 9999: 80, 2026: 40 },
    });
  });
});

describe('project totals carry the billed hours «Per hores» (issues/421)', () => {
  let controller;
  const activities = [
    { id: 1, date: '2026-03-02', hours: 10, cost_by_hour: 20, users_permissions_user: { id: 1 } },
    { id: 2, date: '2026-03-03', hours: 5, cost_by_hour: 20, users_permissions_user: { id: 2 } },
  ];
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (_uid, build) => build({ strapi: global.strapi }) },
    }));
    jest.doMock('../src/services/calendars', () => ({ getDailyDedications: async () => [], getFestives: async () => [] }));
    jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ options: {} }) }));
    global.strapi = {
      db: { query: (uid) => ({ findMany: async () => (uid === 'api::activity.activity' ? activities : []), findOne: async () => null, count: async () => 0 }) },
    };
    controller = require('../src/api/project/controllers/project');
  });
  afterEach(() => {
    delete global.strapi;
    jest.dontMock('@strapi/strapi');
    jest.dontMock('../src/services/calendars');
    jest.dontMock('../src/services/me-settings');
  });

  const project = (mode) => ({
    id: 5,
    billing_mode: mode,
    invoice_hours_price: 40,
    project_phases: [{ id: 1, incomes: [{ id: 3, estimated_hours: [{ users_permissions_user: { id: 1 }, from: '2026-01-01', to: '2026-12-31', price: 60 }] }], expenses: [] }],
    project_original_phases: [],
  });

  it('adds total_real_hours_billed to the totals and to each year', async () => {
    const data = await controller.calculateProject(project('hours'), 5);
    expect(data.total_real_hours_billed).toBe(10 * 60 + 5 * 40);
    expect(data.allByYear.find((y) => y.year === '2026').total_real_hours_billed).toBe(800);
  });

  it('a project billed per project has none', async () => {
    const data = await controller.calculateProject(project('project'), 5);
    expect(data.total_real_hours_billed).toBe(undefined);
  });
});
