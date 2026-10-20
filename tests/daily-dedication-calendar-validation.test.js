'use strict';

/**
 * issues/225 (redesign review 5, 2026-10-19):
 * - POST /api/daily-dedications with from 2027-12-01 / to 2027-06-01, or hours
 *   −3, answered 201 (only overlaps were refused). A period must end on or
 *   after its start and have 0 or more hours.
 * - GET /api/activities/calendar?user=8 answered 500: the unknown parameter
 *   reached the database as a column. A bad query is a 400.
 */

const DEDICATION = 'api::daily-dedication.daily-dedication';

let lifecycles;
let saved;

beforeEach(() => {
  jest.resetModules();
  saved = { id: 5, from: '2027-01-01', to: '2027-06-30', hours: 8 };
  const dedicationQuery = {
    findMany: jest.fn(async () => [saved]),
    findOne: jest.fn(async () => saved),
  };
  const activityQuery = { findMany: jest.fn(async () => []), update: jest.fn() };
  global.strapi = {
    db: { query: jest.fn((uid) => (uid === DEDICATION ? dedicationQuery : activityQuery)) },
  };
  lifecycles = require('../src/api/daily-dedication/content-types/daily-dedication/lifecycles');
});

afterEach(() => {
  delete global.strapi;
});

const user = { set: [{ id: 8 }] };

describe('daily-dedication validation (issues/225)', () => {
  it('refuses a period that ends before it starts', async () => {
    const data = { from: '2027-12-01', to: '2027-11-01', hours: 8, users_permissions_user: user };
    await expect(lifecycles.beforeCreate({ params: { data } })).rejects.toThrow(/ends before it starts/);
  });

  it('refuses negative hours', async () => {
    const data = { from: '2027-07-01', to: '2027-12-31', hours: -3, users_permissions_user: user };
    await expect(lifecycles.beforeCreate({ params: { data } })).rejects.toThrow(/0 or more/);
  });

  it('accepts a one-day period with 0 h', async () => {
    const data = { from: '2027-07-01', to: '2027-07-01', hours: 0, users_permissions_user: user };
    await expect(lifecycles.beforeCreate({ params: { data } })).resolves.toBeUndefined();
  });

  it('checks a partial update against the saved dates', async () => {
    const data = { to: '2026-12-31', users_permissions_user: user };
    await expect(
      lifecycles.beforeUpdate({ params: { data, where: { id: 5 } } }),
    ).rejects.toThrow(/ends before it starts/);
  });

  it('the error is an ApplicationError (400 with the message)', async () => {
    const data = { from: '2027-08-01', to: '2027-12-31', hours: -1, users_permissions_user: user };
    const err = await lifecycles.beforeCreate({ params: { data } }).catch((e) => e);
    expect(err.name).toBe('ApplicationError');
  });
});

describe('activities/calendar bad params (issues/225)', () => {
  const unknownColumn = () =>
    Object.assign(new Error("select ... - Unknown column 't0.user' in 'where clause'"), {
      code: 'ER_BAD_FIELD_ERROR',
      sqlMessage: "Unknown column 't0.user' in 'where clause'",
    });

  const load = (findMany) => {
    global.strapi = { db: { query: jest.fn(() => ({ findMany })) } };
    const factory = require('../src/api/activity/controllers/activity');
    return factory;
  };

  const ctxFor = (query) => ({
    query,
    badRequest: jest.fn((msg) => ({ status: 400, msg })),
  });


  it.each(['getForCalendar', 'totalByDay'])('%s answers 400 to an unknown parameter', async (action) => {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (uid, fn) => fn({ strapi: global.strapi }) },
    }));
    const findMany = jest.fn(async () => {
      throw unknownColumn();
    });
    const controller = load(findMany);
    const ctx = ctxFor({ user: '8' });
    const res = await controller[action].call(controller, ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(expect.stringMatching(/Unknown column/));
    expect(res.status).toBe(400);
  });

  it('a server failure is still rethrown', async () => {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (uid, fn) => fn({ strapi: global.strapi }) },
    }));
    const controller = load(jest.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }));
    const ctx = ctxFor({});
    await expect(controller.getForCalendar(ctx)).rejects.toThrow(/ECONNREFUSED/);
    expect(ctx.badRequest).not.toHaveBeenCalled();
  });

  it('a good query still returns the rows', async () => {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (uid, fn) => fn({ strapi: global.strapi }) },
    }));
    const controller = load(jest.fn(async () => [{ id: 1, date: '2026-10-01', hours: 2 }]));
    const res = await controller.totalByDay(ctxFor({ date_gte: '2026-10-01' }));
    expect(res).toEqual([{ date: '2026-10-01', hours: 2 }]);
  });
});
