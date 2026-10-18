'use strict';

/**
 * issues/156 (2026-10-18): transfer and collection dates used only the
 * route's first weekday and ignored the route closures.
 *
 * - calculateTransferRoute walked back from the delivery date looking for a
 *   transfer route running that day, but took only each route's first ticked
 *   weekday (a Monday+Thursday route never transferred on Thursday) and did
 *   not skip the days the route is closed in «Rutes i dies» (route-festives).
 * - calculateEstimatedDeliveryDate (the date of a collection order with no
 *   date) took the first weekday too, never matched a Sunday route, and
 *   ignored the closures.
 * Both now use src/api/order/services/route-days.js, the same rule as the
 * front's assignRouteDate: every weekday of the route, minus its closures (a
 * closure without a route closes them all).
 */

let TRANSFER_ROUTES = [];
let CLOSURES = [];

function stubStrapi() {
  global.strapi = {
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async () => null),
        findMany: jest.fn(async ({ where }) => {
          if (uid === 'api::route.route') return TRANSFER_ROUTES;
          if (uid === 'api::route-festive.route-festive') {
            return CLOSURES.filter((c) => c.date >= where.date.$gte && c.date <= where.date.$lte);
          }
          return [];
        }),
      })),
    },
  };
}

describe('transfer and collection dates follow every route day and its closures (issues/156)', () => {
  let helpers;
  beforeEach(() => {
    jest.resetModules();
    TRANSFER_ROUTES = [];
    CLOSURES = [];
    stubStrapi();
    helpers = require('../src/api/order/content-types/order/lifecycles').collectionOrderHelpers;
  });
  afterEach(() => jest.useRealTimers());

  // 2026-10-15 is a Thursday
  it('transfers on any weekday of the transfer route, not only the first', async () => {
    TRANSFER_ROUTES = [{ id: 5, monday: true, thursday: true, is_transfer_route: true, active: true }];
    const info = await helpers.calculateTransferRoute('2026-10-15');
    expect(info).toEqual({ transfer_route: 5, transfer_route_date: '2026-10-15' });
  });

  it('skips the days the transfer route is closed', async () => {
    TRANSFER_ROUTES = [{ id: 5, monday: true, thursday: true, is_transfer_route: true, active: true }];
    CLOSURES = [{ id: 1, date: '2026-10-15', route: { id: 5 } }];
    const info = await helpers.calculateTransferRoute('2026-10-15');
    expect(info).toEqual({ transfer_route: 5, transfer_route_date: '2026-10-12' });
  });

  it('a closure of another route leaves it open; one without a route closes it', async () => {
    TRANSFER_ROUTES = [{ id: 5, thursday: true, is_transfer_route: true, active: true }];
    CLOSURES = [{ id: 1, date: '2026-10-15', route: { id: 9 } }];
    expect((await helpers.calculateTransferRoute('2026-10-15')).transfer_route_date).toBe('2026-10-15');
    CLOSURES = [{ id: 1, date: '2026-10-15', route: null }];
    expect((await helpers.calculateTransferRoute('2026-10-15')).transfer_route_date).toBe('2026-10-08');
  });

  it('keeps the only_previous_days restriction', async () => {
    TRANSFER_ROUTES = [
      { id: 5, tuesday: true, thursday: true, is_transfer_route: true, active: true, is_transfer_route_date: 'only_previous_days' },
    ];
    const info = await helpers.calculateTransferRoute('2026-10-15');
    expect(info).toEqual({ transfer_route: 5, transfer_route_date: '2026-10-13' });
  });

  it("a collection order without a date gets the route's next open day", async () => {
    jest.useFakeTimers({ now: new Date('2026-10-13T10:00:00+02:00'), doNotFake: ['nextTick', 'setImmediate'] }); // Tuesday
    // Monday + Thursday: the first weekday gave next Monday
    expect(await helpers.calculateEstimatedDeliveryDate({ id: 3, monday: true, thursday: true })).toBe('2026-10-15');
    // that Thursday closed: next Monday
    CLOSURES = [{ id: 1, date: '2026-10-15', route: { id: 3 } }];
    expect(await helpers.calculateEstimatedDeliveryDate({ id: 3, monday: true, thursday: true })).toBe('2026-10-19');
    // a Sunday route was never found
    CLOSURES = [];
    expect(await helpers.calculateEstimatedDeliveryDate({ id: 4, sunday: true })).toBe('2026-10-18');
    expect(await helpers.calculateEstimatedDeliveryDate({ id: 4 })).toBe(null);
  });
});
