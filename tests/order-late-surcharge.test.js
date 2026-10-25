'use strict';

/**
 * issues/315 (2026-10-21, La Diligència): an order for tomorrow entered past
 * «Hora límit per a l'endemà» was refused by the API and moved by the form to
 * the route's next day, so it mixed with next week's orders and the delivery
 * note printed the wrong day. It is now accepted for the day asked, marked
 * late (red, «COMANDA EXPRESS» on the note) with a surcharge (25 % by default)
 * that the office can cancel («Recàrrec per incidència»). A farm pickup entered
 * too late (10 h of the same day for an afternoon pickup, the next-day limit
 * of the day before for a morning one) is marked late, without surcharge, and
 * so is the collection order (-R) it is in.
 */

const fs = require('fs');
const moment = require('moment');
const os = require('os');
const path = require('path');

const src = (...p) => path.join(__dirname, '..', 'src', ...p);

function mockCoreController(base) {
  jest.doMock('@strapi/strapi', () => ({
    factories: {
      createCoreController: (_uid, cfg) => Object.setPrototypeOf(cfg({ strapi: global.strapi }), base),
    },
  }));
}

describe('late rules (services/late-order)', () => {
  const { isLateDelivery, isLatePickup, isAfternoonSlot, lateRules } = require('../src/services/late-order');
  const rules = lateRules({ next_day_limit_hour: 13 });
  const at = (hhmm) => new Date(`2026-10-21T${hhmm}:00`);

  it('takes the defaults for the empty settings', () => {
    const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
    expect(lateRules(null)).toEqual({ nextDayLimitHour: 14, pickupSameDayLimitHour: 10, lateSurcharge: 25, workingDays: weekdays });
    expect(lateRules({ next_day_limit_hour: 13, pickup_same_day_limit_hour: 9, late_surcharge: 30 })).toEqual({
      nextDayLimitHour: 13,
      pickupSameDayLimitHour: 9,
      lateSurcharge: 30,
      workingDays: weekdays,
    });
  });

  it('a delivery for tomorrow is late from the next-day limit on', () => {
    expect(isLateDelivery('2026-10-22', at('12:59'), rules)).toBe(false);
    expect(isLateDelivery('2026-10-22', at('13:00'), rules)).toBe(true);
    expect(isLateDelivery('2026-10-23', at('20:00'), rules)).toBe(false);
  });

  it('an afternoon pickup is late on its own day from 10 h', () => {
    expect(isLatePickup('2026-10-21', at('09:59'), rules, { afternoon: true })).toBe(false);
    expect(isLatePickup('2026-10-21', at('10:00'), rules, { afternoon: true })).toBe(true);
    expect(isLatePickup('2026-10-22', at('20:00'), rules, { afternoon: true })).toBe(false);
  });

  it('a morning pickup is late on the day before from the next-day limit, and on its own day', () => {
    expect(isLatePickup('2026-10-22', at('12:59'), rules)).toBe(false);
    expect(isLatePickup('2026-10-22', at('13:00'), rules)).toBe(true);
    expect(isLatePickup('2026-10-21', at('08:00'), rules)).toBe(true);
    expect(isLatePickup('2026-10-23', at('20:00'), rules)).toBe(false);
  });

  // «Dies laborables» (2026-10-25): the limit of a day is that of the working
  // day before it, so Friday's limit closes Monday and the weekend counts as
  // late for Monday. 2026-10-23 is a Friday.
  describe('working days', () => {
    const { workingDaysOf, deadlineOf } = require('../src/services/late-order');
    const fri = (hhmm) => new Date(`2026-10-23T${hhmm}:00`);
    const weekdays = lateRules({ next_day_limit_hour: 14 });
    const withSaturday = lateRules({
      next_day_limit_hour: 14,
      working_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    });

    it('defaults to Monday–Friday and keeps only valid days, in week order', () => {
      expect(workingDaysOf(null)).toEqual(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
      expect(workingDaysOf([])).toEqual(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
      expect(workingDaysOf(['nope'])).toEqual(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
      expect(workingDaysOf(['sunday', 'Saturday', 'monday'])).toEqual(['monday', 'saturday', 'sunday']);
    });

    it("Monday's deadline is Friday's limit", () => {
      expect(moment(deadlineOf('2026-10-26', weekdays)).format('YYYY-MM-DD HH:mm')).toBe('2026-10-23 14:00');
      expect(moment(deadlineOf('2026-10-27', weekdays)).format('YYYY-MM-DD HH:mm')).toBe('2026-10-26 14:00');
      expect(moment(deadlineOf('2026-10-26', withSaturday)).format('YYYY-MM-DD HH:mm')).toBe('2026-10-24 14:00');
    });

    it('a Monday delivery is late from Friday 14 h and all weekend', () => {
      expect(isLateDelivery('2026-10-26', fri('13:59'), weekdays)).toBe(false);
      expect(isLateDelivery('2026-10-26', fri('14:00'), weekdays)).toBe(true);
      expect(isLateDelivery('2026-10-26', new Date('2026-10-24T10:00:00'), weekdays)).toBe(true);
      expect(isLateDelivery('2026-10-26', new Date('2026-10-25T20:00:00'), weekdays)).toBe(true);
    });

    it('a Tuesday delivery is on time until Monday 14 h', () => {
      expect(isLateDelivery('2026-10-27', fri('16:00'), weekdays)).toBe(false);
      expect(isLateDelivery('2026-10-27', new Date('2026-10-25T20:00:00'), weekdays)).toBe(false);
      expect(isLateDelivery('2026-10-27', new Date('2026-10-26T13:59:00'), weekdays)).toBe(false);
      expect(isLateDelivery('2026-10-27', new Date('2026-10-26T14:00:00'), weekdays)).toBe(true);
    });

    it('with Saturday as a working day, Monday closes on Saturday 14 h', () => {
      expect(isLateDelivery('2026-10-26', fri('16:00'), withSaturday)).toBe(false);
      expect(isLateDelivery('2026-10-26', new Date('2026-10-24T13:59:00'), withSaturday)).toBe(false);
      expect(isLateDelivery('2026-10-26', new Date('2026-10-24T14:00:00'), withSaturday)).toBe(true);
    });

    it('a morning pickup on Monday follows the same deadline; an afternoon one only its own day', () => {
      expect(isLatePickup('2026-10-26', fri('13:59'), weekdays)).toBe(false);
      expect(isLatePickup('2026-10-26', fri('14:00'), weekdays)).toBe(true);
      expect(isLatePickup('2026-10-26', new Date('2026-10-25T09:00:00'), weekdays)).toBe(true);
      expect(isLatePickup('2026-10-26', new Date('2026-10-25T09:00:00'), weekdays, { afternoon: true })).toBe(false);
    });

    it('today and past days are never late here (refused elsewhere)', () => {
      expect(isLateDelivery('2026-10-23', fri('16:00'), weekdays)).toBe(false);
      expect(isLateDelivery('2026-10-22', fri('16:00'), weekdays)).toBe(false);
    });
  });

  it('a slot starting at 13 h or later is an afternoon one', () => {
    expect(isAfternoonSlot('13:00:00.000')).toBe(true);
    expect(isAfternoonSlot('15:30')).toBe(true);
    expect(isAfternoonSlot('09:00:00')).toBe(false);
    expect(isAfternoonSlot(null)).toBe(false);
  });
});

describe('the price of a late order', () => {
  const { orderDiscountedPrice, orderInvoiceLine } = require('../src/api/order/services/final-price');
  const { orderLineConcept } = require('../src/api/order/services/invoice-line-concept');

  it('adds the surcharge to the base, before the discounts', () => {
    const order = { price: 10, volume_discount: 2, multidelivery_discount: 10, late_order: true, late_surcharge: 25 };
    expect(orderInvoiceLine(order)).toEqual({ base: 10, discount: 10 });
    expect(orderDiscountedPrice(order)).toBe(9);
  });

  it('charges nothing more once the office unchecks it', () => {
    expect(orderDiscountedPrice({ price: 10, late_order: false, late_surcharge: 25 })).toBe(10);
  });

  it('says so on the invoice line', () => {
    expect(
      orderLineConcept({ id: 25431, estimated_delivery_date: '2026-10-22', route: { name: 'R1' }, late_order: true, late_surcharge: 25 }),
    ).toBe('Comanda 22/10/2026 | 25431 | R1 | Express +25 %');
  });

  it('the list filter computes it in SQL too', () => {
    const controller = fs.readFileSync(src('api', 'order', 'controllers', 'order.js'), 'utf8');
    expect(controller).toMatch(/CASE WHEN late_order THEN COALESCE\(late_surcharge, 0\)/);
  });
});

describe('order controller: late flags', () => {
  const NOW = new Date('2026-10-21T14:30:00');
  let routes;
  let cityRoutes;

  function load({ permissions = ['orders'], stored = null, options = { next_day_limit_hour: 13 } } = {}) {
    jest.resetModules();
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    const base = {
      create: jest.fn(async () => ({ data: { id: 1 } })),
      update: jest.fn(async () => ({ data: { id: 1 } })),
    };
    global.strapi = {
      db: {
        query: (uid) => ({
          findOne: async ({ where }) => {
            if (uid === 'plugin::users-permissions.user') {
              return { id: where.id, permissions: permissions.map((permission) => ({ permission })) };
            }
            if (uid === 'api::route.route') return routes[where.id] || null;
            if (uid === 'api::contact.contact') return { id: where.id, city: 'Vic' };
            if (uid === 'api::city.city') return { id: 70 };
            if (uid === 'api::city-route.city-route') return cityRoutes[where.route] || null;
            return stored;
          },
        }),
      },
    };
    jest.doMock(src('services', 'me-settings'), () => ({
      getMe: async () => ({ orders_options: options }),
      frontUrlOf: () => '',
    }));
    mockCoreController(base);
    const ctrl = require(src('api', 'order', 'controllers', 'order'));
    return { ctrl, base };
  }

  const ctxFor = (data, extra = {}) => ({
    state: { user: { id: 100 }, ...(extra.state || {}) },
    params: {},
    request: { body: { data } },
    badRequest: jest.fn((message) => message),
  });
  const order = (extra = {}) => ({ route: 3, contact: 4, estimated_delivery_date: '2026-10-24', ...extra });

  beforeEach(() => {
    routes = { 5: { id: 5, time_from: '09:00:00.000' }, 6: { id: 6, time_from: '15:00:00.000' } };
    cityRoutes = {};
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.dontMock('@strapi/strapi');
    jest.dontMock(src('services', 'me-settings'));
    delete global.strapi;
  });

  it('marks an order for tomorrow entered past the limit late, with the configured surcharge', async () => {
    const { ctrl, base } = load({ options: { next_day_limit_hour: 13, late_surcharge: 30 } });
    const ctx = ctxFor(order({ estimated_delivery_date: '2026-10-22' }));
    await ctrl.create(ctx);
    expect(base.create).toHaveBeenCalled();
    expect(ctx.request.body.data).toMatchObject({ late_order: true, late_surcharge: 30 });
  });

  it('leaves an order on time unmarked', async () => {
    const { ctrl } = load();
    const ctx = ctxFor(order());
    await ctrl.create(ctx);
    expect(ctx.request.body.data).toMatchObject({ late_order: false, late_surcharge: 0 });
  });

  it("doesn't mark the office's orders: it checks the box by hand", async () => {
    const { ctrl } = load({ permissions: ['orders_admin'] });
    const late = ctxFor(order({ estimated_delivery_date: '2026-10-22' }));
    await ctrl.create(late);
    expect(late.request.body.data.late_order).toBeUndefined();

    const checked = ctxFor(order({ late_order: true }));
    await ctrl.create(checked);
    expect(checked.request.body.data).toMatchObject({ late_order: true, late_surcharge: 25 });
  });

  it('unchecking «Recàrrec per incidència» takes the surcharge off', async () => {
    const { ctrl } = load({ permissions: ['orders_admin'], stored: { id: 1, late_surcharge: 25 } });
    const ctx = ctxFor({ late_order: false }, { state: { v3: { numericId: 1 } } });
    await ctrl.update(ctx);
    expect(ctx.request.body.data).toEqual({ late_order: false, late_surcharge: 0 });
  });

  it('an afternoon pickup today past 10 h is late, without surcharge', async () => {
    const { ctrl } = load();
    const ctx = ctxFor(order({ collection_point: 8, collection_pickup_route: 6, collection_pickup_date: '2026-10-21' }));
    await ctrl.create(ctx);
    expect(ctx.request.body.data).toMatchObject({ late_pickup: true, late_order: false, late_surcharge: 0 });
  });

  it("a morning pickup for tomorrow past the next-day limit is late; the town's slot counts first", async () => {
    const morning = load();
    const ctx = ctxFor(order({ collection_point: 8, collection_pickup_route: 5, collection_pickup_date: '2026-10-22' }));
    await morning.ctrl.create(ctx);
    expect(ctx.request.body.data.late_pickup).toBe(true);

    // the route runs in the morning, but passes by the farm's town at 16 h
    cityRoutes = { 5: { id: 1, time_from: '16:00:00.000' } };
    const town = load();
    const afternoon = ctxFor(order({ collection_point: 8, collection_pickup_route: 5, collection_pickup_date: '2026-10-22' }));
    await town.ctrl.create(afternoon);
    expect(afternoon.request.body.data.late_pickup).toBe(false);
  });

  it('judges a pickup again only when its date moves', async () => {
    const stored = { id: 1, estimated_delivery_date: '2026-10-24', collection_pickup_date: '2026-10-22', collection_pickup_route: { id: 5 }, collection_point: { id: 8 } };
    const same = load({ stored });
    const keep = ctxFor({ collection_pickup_date: '2026-10-22', units: 3 }, { state: { v3: { numericId: 1 } } });
    await same.ctrl.update(keep);
    expect(keep.request.body.data.late_pickup).toBeUndefined();

    const moved = load({ stored });
    const ctx = ctxFor({ collection_pickup_date: '2026-10-21' }, { state: { v3: { numericId: 1 } } });
    await moved.ctrl.update(ctx);
    expect(ctx.request.body.data.late_pickup).toBe(true);
  });
});

describe('the routes of a collection point', () => {
  it("say when they pass by the farm's town, to tell morning from afternoon pickups", async () => {
    jest.resetModules();
    global.strapi = {
      db: {
        query: (uid) => ({
          findOne: async () => (uid === 'api::contact.contact' ? { id: 8, city: 'Vic' } : null),
          findMany: async () => {
            if (uid === 'api::city.city') return [{ id: 70 }];
            if (uid === 'api::city-route.city-route') {
              return [
                { id: 1, route: { id: 5 }, time_from: '16:00:00.000' },
                { id: 2, route: { id: 6 }, time_from: null },
              ];
            }
            if (uid === 'api::route.route') {
              return [
                { id: 5, time_from: '09:00:00.000' },
                { id: 6, time_from: '08:00:00.000' },
              ];
            }
            return [];
          },
        }),
      },
    };
    mockCoreController({});
    const ctrl = require(src('api', 'order', 'controllers', 'order'));
    const routes = await ctrl.collectionPointRoutes({ query: { collection_point: 8 }, badRequest: jest.fn() });
    expect(routes.map((r) => [r.id, r.pickup_time_from])).toEqual([
      [5, '16:00:00.000'],
      [6, '08:00:00.000'],
    ]);
    jest.dontMock('@strapi/strapi');
    delete global.strapi;
  });
});

describe('a collection order (-R) with a late pickup', () => {
  let rows;
  const recompute = async () => {
    jest.resetModules();
    const query = jest.fn((uid) => ({
      findOne: jest.fn(async ({ where }) => (uid === 'api::order.order' && rows[where.id] ? { ...rows[where.id] } : null)),
      findMany: jest.fn(async ({ where } = {}) => {
        if (uid !== 'api::order.order') return [];
        return Object.values(rows).filter((r) => r.collection_order && r.collection_order.id === where.collection_order);
      }),
      update: jest.fn(async ({ where, data }) => {
        const { _internal, ...rest } = data;
        rows[where.id] = { ...rows[where.id], ...rest };
        return rows[where.id];
      }),
    }));
    global.strapi = { log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, db: { query }, query };
    const { collectionOrderHelpers } = require('../src/api/order/content-types/order/lifecycles');
    await collectionOrderHelpers.updateCollectionOrderAggregates(900);
    return rows[900];
  };
  const child = (id, late_pickup) => ({ id, status: 'pending', collection_order: { id: 900 }, units: 1, kilograms: 2, late_pickup });

  it('is late when one of its orders is, and no longer when none is', async () => {
    rows = { 900: { id: 900, is_collection_order: true, status: 'pending', route: null }, 1: child(1, false), 2: child(2, true) };
    expect((await recompute()).late_pickup).toBe(true);
    rows[2].late_pickup = false;
    expect((await recompute()).late_pickup).toBe(false);
  });
});

describe('the delivery note of a late order', () => {
  const cwd = process.cwd();
  let tmp;
  let texts;

  beforeEach(() => {
    jest.resetModules();
    texts = [];
    const PDFKit = require('pdfkit');
    const text = PDFKit.prototype.text;
    jest.spyOn(PDFKit.prototype, 'text').mockImplementation(function (value, ...rest) {
      texts.push(String(value));
      return text.call(this, value, ...rest);
    });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'order-express-'));
    fs.mkdirSync(path.join(tmp, 'public', 'uploads'), { recursive: true });
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
    delete global.strapi;
    jest.restoreAllMocks();
  });

  const print = async (extra) => {
    const orders = [
      {
        id: 1,
        createdAt: '2026-10-01T08:00:00.000Z',
        units: 2,
        kilograms: 5,
        estimated_delivery_date: '2026-10-22',
        owner: { id: 7, username: 'productora' },
        contact: { trade_name: 'Botiga', address: 'Carrer Major 1', postcode: '08001', city: 'Barcelona' },
        route: { name: 'R1' },
        ...extra,
      },
    ];
    const ct = { uid: 'api::order.order', modelName: 'order', apiName: 'order', kind: 'collectionType', attributes: {} };
    global.strapi = {
      contentType: () => ct,
      contentTypes: { 'api::order.order': ct },
      log: { warn: () => {}, info: () => {} },
      documents: (uid) => ({
        findFirst: async () => (uid === 'api::me.me' ? { name: 'La Diligència' } : { front_url: 'https://example.org/' }),
      }),
      db: {
        query: (uid) => ({
          findMany: async () => (uid === 'api::contact.contact' ? [{ id: 9, name: 'Productora SCCL' }] : orders),
        }),
      },
    };
    const ctrl = require(src('api', 'order', 'controllers', 'order'))({ strapi: global.strapi });
    await ctrl.pdfmultiple({ request: { body: { orders: [1] } }, send: () => {} });
  };

  it('prints «COMANDA EXPRESS» on every box', async () => {
    await print({ late_order: true, late_surcharge: 25 });
    expect(texts.filter((t) => t === 'COMANDA EXPRESS')).toHaveLength(2);
  });

  it('not on an order on time, nor once the office unchecks it', async () => {
    await print({ late_order: false, late_surcharge: 0 });
    expect(texts).not.toContain('COMANDA EXPRESS');
  });
});
