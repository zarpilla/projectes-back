'use strict';

/**
 * issues/210 (review 4, 2026-10-19): `POST /api/orders {"data":{}}` answered
 * 201 and `POST /api/orders/csv {}` 200, both creating pending orders without
 * route, delivery point or date (they showed in the office's Pendents and
 * skipped the cutoff). An empty body on check-multidelivery, pdf and invoice
 * crashed with 500 (`orderIds.length` of undefined). Now: 400 with a message.
 * The bodies the app itself sends still go through.
 */

const path = require('path');

const src = (...parts) => path.join(__dirname, '..', 'src', ...parts);

function load() {
  jest.resetModules();
  const base = { create: jest.fn(async () => ({ data: { id: 1 } })) };
  const serviceCreate = jest.fn(async () => ({ id: 9 }));
  global.strapi = {
    db: {
      query: (uid) => ({
        findOne: async ({ where } = {}) =>
          uid === 'plugin::users-permissions.user'
            ? { id: where.id, permissions: [{ permission: 'orders' }] }
            : null,
        findMany: async () => [],
      }),
    },
    service: () => ({ create: serviceCreate }),
  };
  jest.doMock('@strapi/strapi', () => ({
    factories: {
      createCoreController: (_uid, cfg) => Object.setPrototypeOf(cfg({ strapi: global.strapi }), base),
    },
  }));
  jest.doMock(src('services', 'me-settings'), () => ({
    getMe: async () => ({ orders_options: { next_day_limit_hour: 14, multidelivery_discount: 20 } }),
    frontUrlOf: () => '',
  }));
  jest.doMock(src('api', 'order', 'services', 'volume-discount'), () => ({
    currentOrderVolumeDiscount: async () => undefined,
  }));
  const ctrl = require(src('api', 'order', 'controllers', 'order'));
  return { ctrl, base, serviceCreate };
}

const ctxFor = (body) => ({
  state: { user: { id: 100 } },
  params: {},
  request: { body },
  badRequest: jest.fn((message) => message),
  send: jest.fn(),
});

// a date far enough ahead for the cutoff never to apply
const DAY = '2099-03-10';

afterEach(() => {
  delete global.strapi;
  jest.dontMock('@strapi/strapi');
  jest.dontMock(src('services', 'me-settings'));
  jest.dontMock(src('api', 'order', 'services', 'volume-discount'));
});

describe('order create (issues/210)', () => {
  it.each([
    [{}, /falta la ruta/],
    [{ route: 3, estimated_delivery_date: DAY }, /falta el punt d'entrega/],
    [{ route: 3, contact: 4 }, /falta la data prevista/],
    [{ route: null, contact: 4, estimated_delivery_date: DAY }, /falta la ruta/],
  ])('refuses %j', async (data, message) => {
    const { ctrl, base } = load();
    const ctx = ctxFor({ data });
    await ctrl.create(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(expect.stringMatching(message));
    expect(base.create).not.toHaveBeenCalled();
  });

  it('creates what the order form sends', async () => {
    const { ctrl, base } = load();
    const ctx = ctxFor({ data: { route: 3, contact: 4, estimated_delivery_date: `${DAY}T22:00:00.000Z` } });
    await ctrl.create(ctx);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(base.create).toHaveBeenCalled();
  });

  it('takes relations as objects or connect too', async () => {
    const { ctrl, base } = load();
    await ctrl.create(
      ctxFor({ data: { route: { id: 3 }, contact: { connect: [{ id: 4 }] }, estimated_delivery_date: DAY } }),
    );
    expect(base.create).toHaveBeenCalled();
  });
});

describe('order CSV import (issues/210)', () => {
  it('refuses an empty body', async () => {
    const { ctrl, serviceCreate } = load();
    const ctx = ctxFor({});
    await ctrl.createCSV(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(expect.stringMatching(/falta la ruta/));
    expect(serviceCreate).not.toHaveBeenCalled();
  });

  it('refuses a row without delivery point, creating no point', async () => {
    const { ctrl, serviceCreate } = load();
    const ctx = ctxFor({
      route: { id: 3 },
      contact: { id: undefined, name: '' },
      estimated_delivery_date: DAY,
    });
    await ctrl.createCSV(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(expect.stringMatching(/falta el punt d'entrega/));
    expect(serviceCreate).not.toHaveBeenCalled();
  });

  it('creates a row with a known point, and one with a new point', async () => {
    const known = load();
    const ctx = ctxFor({
      route: { id: 3 },
      owner: { id: 100 },
      contact: { id: 4 },
      estimated_delivery_date: DAY,
    });
    await known.ctrl.createCSV(ctx);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(known.serviceCreate).toHaveBeenCalledTimes(1);

    const fresh = load();
    const ctx2 = ctxFor({
      route: { id: 3 },
      owner: { id: 100 },
      contact: { name: 'Nou punt' },
      estimated_delivery_date: DAY,
    });
    await fresh.ctrl.createCSV(ctx2);
    expect(ctx2.badRequest).not.toHaveBeenCalled();
    expect(fresh.serviceCreate).toHaveBeenCalledTimes(2); // the point, then the order
  });
});

describe('400 instead of 500 on missing input (issues/210)', () => {
  it.each([[undefined], [{}], [{ date: DAY }], [{ contactId: 4 }]])(
    'check-multidelivery %j',
    async (body) => {
      const { ctrl } = load();
      const ctx = ctxFor(body);
      await ctrl.checkMultidelivery(ctx);
      expect(ctx.badRequest).toHaveBeenCalled();
    },
  );

  it('check-multidelivery answers what the form asks', async () => {
    const { ctrl } = load();
    const ctx = ctxFor({ contactId: 4, date: DAY, ownerId: 100, routeId: 3, status: 'pending' });
    const res = await ctrl.checkMultidelivery(ctx);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(res.multidelivery_discount).toBe(0);
  });

  it.each([[{}], [{ orders: [] }], [{ orders: 'x' }]])('pdf %j', async (body) => {
    const { ctrl } = load();
    const ctx = ctxFor(body);
    await ctrl.pdfmultiple(ctx);
    expect(ctx.badRequest).toHaveBeenCalled();
  });

  it.each([[{}], [{ orders: [] }], [{ project: 1 }]])('invoice %j', async (body) => {
    const { ctrl } = load();
    const ctx = ctxFor(body);
    await ctrl.invoice(ctx);
    expect(ctx.badRequest).toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
  });
});
