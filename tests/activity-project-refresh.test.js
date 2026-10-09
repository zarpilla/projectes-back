'use strict';

/**
 * issues/012 — "Hores executades" stayed at 0 € (or stale) after logging hours.
 *
 * The activity lifecycles marked the project dirty from `event.result.project`,
 * but a v5 db lifecycle result carries no relations: the project was never
 * marked, so the stored total_real_hours(_price) never followed the new
 * activities. Same on delete, where the row was read back unpopulated.
 */

jest.mock('../src/api/project/services/totalsRefreshScheduler', () => ({
  scheduleRefresh: jest.fn(),
}));

const DEDICATION = 'api::daily-dedication.daily-dedication';

let scheduleRefresh;
let lifecycles;
let activityQuery;
let projectOf;

beforeEach(() => {
  jest.resetModules();
  ({ scheduleRefresh } = require('../src/api/project/services/totalsRefreshScheduler'));
  scheduleRefresh.mockClear();

  // activity id -> project id, as stored in activities_project_lnk
  projectOf = { 7: 25 };
  // Like v5's db.query: relations only come back when populated.
  activityQuery = {
    findOne: jest.fn(async ({ where, populate }) => {
      const row = { id: where.id, hours: 2 };
      if (populate && populate.project && projectOf[where.id]) row.project = { id: projectOf[where.id] };
      return row;
    }),
  };
  const dedicationQuery = {
    findMany: jest.fn(async () => [{ id: 1, from: '2026-01-01', to: '2026-12-31', costByHour: 16.45 }]),
  };
  global.strapi = {
    db: { query: jest.fn((uid) => (uid === DEDICATION ? dedicationQuery : activityQuery)) },
  };

  lifecycles = require('../src/api/activity/content-types/activity/lifecycles');
});

afterEach(() => {
  delete global.strapi;
});

describe('activity lifecycles refresh the project totals', () => {
  it('prices a new activity with the cost/hour of the covering dedication', async () => {
    const data = { date: '2026-10-05', hours: 2, users_permissions_user: { set: [{ id: 28 }] } };
    await lifecycles.beforeCreate({ params: { data } });
    expect(data.cost_by_hour).toBe(16.45);
  });

  it('marks the project dirty after a create (result has no relations)', async () => {
    await lifecycles.afterCreate({ params: { data: { project: { set: [{ id: 25 }] } } }, result: { id: 7, hours: 2 } });
    expect(scheduleRefresh).toHaveBeenCalledWith(25);
  });

  it('marks the project dirty after an update', async () => {
    const event = { params: { where: { id: 7 }, data: { hours: 3 } }, state: {} };
    await lifecycles.beforeUpdate(event);
    await lifecycles.afterUpdate({ ...event, result: { id: 7, hours: 3 } });
    expect(scheduleRefresh).toHaveBeenCalledWith(25);
  });

  it('marks both projects dirty when an activity moves to another project', async () => {
    const event = { params: { where: { id: 7 }, data: { project: { set: [{ id: 30 }] } } }, state: {} };
    await lifecycles.beforeUpdate(event);
    projectOf[7] = 30;
    await lifecycles.afterUpdate({ ...event, result: { id: 7 } });
    expect(scheduleRefresh).toHaveBeenCalledWith(25);
    expect(scheduleRefresh).toHaveBeenCalledWith(30);
  });

  it('marks the project dirty before a delete', async () => {
    await lifecycles.beforeDelete({ params: { where: { id: 7 } } });
    expect(scheduleRefresh).toHaveBeenCalledWith(25);
  });
});

describe('refreshStoredTotals', () => {
  it('recomputes a dirty project through the project controller', async () => {
    // calculateProject lives on the controller; the drain called it on the
    // service, so every cron pass failed and dirty projects kept stale totals.
    const calculateProject = jest.fn(async () => ({ total_real_hours: 4, total_real_hours_price: 63.4 }));
    const written = [];
    global.strapi = {
      db: {
        query: jest.fn(() => ({ findOne: jest.fn(async () => ({ id: 5 })) })),
        connection: jest.fn(() => ({
          where: jest.fn(() => ({ update: jest.fn(async (data) => written.push(data)) })),
        })),
      },
      controller: jest.fn(() => ({ calculateProject })),
      service: jest.fn(() => ({})),
    };
    const { refreshStoredTotals } = jest.requireActual('../src/api/project/services/projectFinancials');

    await refreshStoredTotals(5);

    expect(calculateProject).toHaveBeenCalled();
    expect(written[0]).toMatchObject({ total_real_hours: 4, total_real_hours_price: 63.4, dirty: false });
  });
});
