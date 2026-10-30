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
