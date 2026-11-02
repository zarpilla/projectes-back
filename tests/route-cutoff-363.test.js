'use strict';

/**
 * issues/363 (La Diligència): no order for a route after the closing hour
 * («Hora de tancament de la ruta», 14 h) of the working day before. Between
 * the next-day limit (13 h) and the closing it is late: flat surcharge (15 %
 * by default) and an incidence. The office can still enter orders after the
 * closing, with the surcharge. Morning farm pickups close at the same hour.
 * The working day before skips the holidays for everyone.
 *
 * The tests run in UTC (tests/global-setup-tz.js) with the times written in
 * the tenant's zone (Europe/Andorra).
 */

const moment = require('moment');
const path = require('path');

const src = (...p) => path.join(__dirname, '..', 'src', ...p);

describe('route closing rules (services/late-order)', () => {
  const {
    closingOf,
    deadlineOf,
    isClosedDelivery,
    isClosedPickup,
    isLateDelivery,
    lateRules,
  } = require('../src/services/late-order');
  const rules = lateRules({ next_day_limit_hour: 13 });
  const wed = (hhmm) => new Date(`2026-10-21T${hhmm}:00+02:00`);
  const fmt = (m) => moment(m).format('YYYY-MM-DD HH:mm');

  it('Thursday is on time until 13 h, late until 14 h, closed from 14 h on Wednesday', () => {
    expect(isLateDelivery('2026-10-22', wed('12:59'), rules)).toBe(false);
    expect(isLateDelivery('2026-10-22', wed('13:30'), rules)).toBe(true);
    expect(isClosedDelivery('2026-10-22', wed('13:59'), rules)).toBe(false);
    expect(isClosedDelivery('2026-10-22', wed('14:00'), rules)).toBe(true);
    expect(isClosedDelivery('2026-10-22', wed('15:00'), rules)).toBe(true);
    // Friday is still open on Wednesday afternoon
    expect(isClosedDelivery('2026-10-23', wed('15:00'), rules)).toBe(false);
  });

  it('Monday closes on Friday 14 h: the weekend is closed for it', () => {
    expect(fmt(closingOf('2026-10-26', rules))).toBe('2026-10-23 14:00');
    expect(isClosedDelivery('2026-10-26', new Date('2026-10-23T13:59:00+02:00'), rules)).toBe(false);
    expect(isClosedDelivery('2026-10-26', new Date('2026-10-23T14:00:00+02:00'), rules)).toBe(true);
    expect(isClosedDelivery('2026-10-26', new Date('2026-10-24T10:00:00+02:00'), rules)).toBe(true);
    // Tuesday is open all weekend, until Monday 14 h
    expect(isClosedDelivery('2026-10-27', new Date('2026-10-25T20:00:00+01:00'), rules)).toBe(false);
  });

  it('the working day before skips the holidays for everyone', () => {
    // Tuesday 8 December 2026 is a holiday: Wednesday's limits fall on Monday
    const withHoliday = lateRules({ next_day_limit_hour: 13 }, undefined, { holidays: ['2026-12-08'] });
    expect(fmt(deadlineOf('2026-12-09', withHoliday))).toBe('2026-12-07 13:00');
    expect(fmt(closingOf('2026-12-09', withHoliday))).toBe('2026-12-07 14:00');
    // and the holiday itself closes on Monday too
    expect(fmt(closingOf('2026-12-08', withHoliday))).toBe('2026-12-07 14:00');
    // a Monday holiday: Tuesday closes on Friday
    const mondayOff = lateRules({ next_day_limit_hour: 13 }, undefined, { holidays: ['2026-12-07'] });
    expect(fmt(closingOf('2026-12-08', mondayOff))).toBe('2026-12-04 14:00');
    expect(isClosedDelivery('2026-12-08', new Date('2026-12-07T10:00:00+01:00'), mondayOff)).toBe(true);
    // without it, Monday at 10 h is still on time for Tuesday
    expect(isClosedDelivery('2026-12-08', new Date('2026-12-07T10:00:00+01:00'), rules)).toBe(false);
  });

  it('a morning farm pickup closes at the same hour, and on its own day; an afternoon one never', () => {
    expect(isClosedPickup('2026-10-22', wed('13:59'), rules)).toBe(false);
    expect(isClosedPickup('2026-10-22', wed('14:00'), rules)).toBe(true);
    expect(isClosedPickup('2026-10-21', wed('08:00'), rules)).toBe(true);
    expect(isClosedPickup('2026-10-21', wed('08:00'), rules, { afternoon: true })).toBe(false);
    expect(isClosedPickup('2026-10-22', wed('15:00'), rules, { afternoon: true })).toBe(false);
  });

  it('follows the closing hour set', () => {
    const at16 = lateRules({ next_day_limit_hour: 13, route_closing_hour: 16 });
    expect(isClosedDelivery('2026-10-22', wed('15:59'), at16)).toBe(false);
    expect(isClosedDelivery('2026-10-22', wed('16:00'), at16)).toBe(true);
  });
});

describe('order controller: route closing (issues/363)', () => {
  let holidays;
  let incidences;

  function load({ permissions = ['orders'], stored = null, now, options = { next_day_limit_hour: 13 } }) {
    jest.resetModules();
    jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate'] });
    const base = {
      create: jest.fn(async () => ({ data: { id: 41, documentId: 'doc41' } })),
      update: jest.fn(async () => ({ data: { id: 1 } })),
    };
    global.strapi = {
      db: {
        query: (uid) => ({
          findOne: async ({ where }) => {
            if (uid === 'plugin::users-permissions.user') {
              return { id: where.id, permissions: permissions.map((permission) => ({ permission })) };
            }
            if (uid === 'api::route.route') return { id: where.id, afternoon: where.id === 6 };
            return stored;
          },
          findMany: async () => (uid === 'api::festive.festive' ? holidays : []),
          create: async ({ data }) => {
            if (uid === 'api::incidence.incidence') incidences.push(data);
            return { id: 900 + incidences.length, ...data };
          },
        }),
      },
      log: { error: jest.fn(), warn: jest.fn() },
    };
    jest.doMock(src('services', 'me-settings'), () => ({
      getMe: async () => ({ orders_options: options }),
      frontUrlOf: () => '',
    }));
    jest.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (_uid, cfg) => Object.setPrototypeOf(cfg({ strapi: global.strapi }), base),
      },
    }));
    const ctrl = require(src('api', 'order', 'controllers', 'order'));
    return { ctrl, base };
  }

  const ctxFor = (data, extra = {}) => ({
    state: { user: { id: 100 }, ...(extra.state || {}) },
    params: {},
    request: { body: { data } },
    badRequest: jest.fn((message) => message),
  });
  const order = (extra = {}) => ({ route: 3, contact: 4, estimated_delivery_date: '2026-10-22', ...extra });
  const wed = (hhmm) => new Date(`2026-10-21T${hhmm}:00+02:00`);

  beforeEach(() => {
    holidays = [];
    incidences = [];
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.dontMock('@strapi/strapi');
    jest.dontMock(src('services', 'me-settings'));
    delete global.strapi;
  });

  it("refuses a member's order for Thursday entered on Wednesday at 15 h", async () => {
    const { ctrl, base } = load({ now: wed('15:00') });
    const ctx = ctxFor(order());
    const answer = await ctrl.create(ctx);
    expect(base.create).not.toHaveBeenCalled();
    expect(answer).toMatch(/la ruta ja és tancada per a dijous 22\/10/);
    expect(answer).toMatch(/abans de les 14 h de dimecres 21\/10/);
  });

  it('refuses moving an order to a closed day too', async () => {
    const stored = { id: 1, estimated_delivery_date: '2026-10-23', late_surcharge: 0 };
    const { ctrl, base } = load({ now: wed('15:00'), stored });
    const ctx = ctxFor({ estimated_delivery_date: '2026-10-22' }, { state: { v3: { numericId: 1 } } });
    const answer = await ctrl.update(ctx);
    expect(base.update).not.toHaveBeenCalled();
    expect(answer).toMatch(/^No es pot moure la comanda: la ruta ja és tancada/);
  });

  it('accepts it between 13 and 14 h, late with the flat surcharge and an incidence', async () => {
    const { ctrl, base } = load({ now: wed('13:25') });
    const ctx = ctxFor(order());
    await ctrl.create(ctx);
    expect(base.create).toHaveBeenCalled();
    expect(ctx.request.body.data).toMatchObject({ late_order: true, late_surcharge: 15 });
    expect(incidences).toHaveLength(1);
    expect(incidences[0]).toMatchObject({ order: 41, state: 'open', created_user: 100 });
    expect(incidences[0].description).toBe(
      'Comanda fora de temps: informada dimecres 21/10 a les 13:25 per a dijous 22/10 ' +
        '(hora límit: les 13 h del dia laborable anterior). Recàrrec del 15 %.',
    );
  });

  it('opens no incidence for an order on time', async () => {
    const { ctrl } = load({ now: wed('12:00') });
    await ctrl.create(ctxFor(order()));
    expect(incidences).toHaveLength(0);
  });

  it('lets the office enter it after the closing, with the surcharge and the incidence', async () => {
    const { ctrl, base } = load({ now: wed('15:00'), permissions: ['orders_admin'] });
    const ctx = ctxFor(order());
    await ctrl.create(ctx);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(base.create).toHaveBeenCalled();
    expect(ctx.request.body.data).toMatchObject({ late_order: true, late_surcharge: 15 });
    expect(incidences).toHaveLength(1);
  });

  it('a holiday before the delivery day moves its closing a working day earlier', async () => {
    // Tuesday 8 December a holiday: Wednesday 9 closes on Monday 7 at 14 h
    holidays = [
      { id: 1, date: '2026-12-08', users_permissions_user: null },
      { id: 2, date: '2026-12-04', users_permissions_user: { id: 7 } },
    ];
    const { ctrl, base } = load({ now: new Date('2026-12-08T09:00:00+01:00') });
    const ctx = ctxFor(order({ estimated_delivery_date: '2026-12-09' }));
    const answer = await ctrl.create(ctx);
    expect(base.create).not.toHaveBeenCalled();
    expect(answer).toMatch(/abans de les 14 h de dilluns 7\/12/);
  });

  it("refuses a member's morning farm pickup past its closing; an afternoon one is only late", async () => {
    const morning = load({ now: wed('15:00') });
    const ctx = ctxFor(
      order({
        estimated_delivery_date: '2026-10-24',
        collection_point: 8,
        collection_pickup_route: 5,
        collection_pickup_date: '2026-10-22',
      }),
    );
    const answer = await morning.ctrl.create(ctx);
    expect(morning.base.create).not.toHaveBeenCalled();
    expect(answer).toMatch(/la recollida de dijous 22\/10 ja és tancada/);

    const tarda = load({ now: wed('15:00') });
    const afternoon = ctxFor(
      order({
        estimated_delivery_date: '2026-10-24',
        collection_point: 8,
        collection_pickup_route: 6,
        collection_pickup_date: '2026-10-21',
      }),
    );
    await tarda.ctrl.create(afternoon);
    expect(tarda.base.create).toHaveBeenCalled();
    expect(afternoon.request.body.data.late_pickup).toBe(true);
    expect(incidences).toHaveLength(1);
    expect(incidences[0].description).toBe(
      'Recollida informada tard: informada dimecres 21/10 a les 15:00 per a dimecres 21/10.',
    );
  });
});
