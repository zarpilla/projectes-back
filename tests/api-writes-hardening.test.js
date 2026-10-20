'use strict';

/**
 * issues/163-168 (redesign review 2026-10-18), the parts outside the
 * app-permissions middleware (tests/app-permissions.test.js has the rest):
 *
 * - 163: a driver moved the deposit date of an invoiced order.
 * - 164: an incidence update replaced the replies with whatever was sent,
 *   authors included.
 * - 165: the same salary and project fields reached through other types.
 * - 167: «Contacta» lost the message when the mail failed, and took the user
 *   and the recipient from the body.
 * - 168: the next-day cutoff read only the v3 body and ran only on create;
 *   today, the past and orders without state went through.
 */

const path = require('path');

const src = (...parts) => path.join(__dirname, '..', 'src', ...parts);

function mockCoreController(base) {
  jest.doMock('@strapi/strapi', () => ({
    factories: {
      createCoreController: (_uid, cfg) => Object.setPrototypeOf(cfg({ strapi: global.strapi }), base),
    },
  }));
}

afterEach(() => {
  delete global.strapi;
  jest.useRealTimers();
  jest.dontMock('@strapi/strapi');
  jest.dontMock(src('services', 'me-settings'));
});

describe('deposit guard on invoiced orders (issues/163)', () => {
  let guard;
  beforeEach(() => {
    jest.resetModules();
    const orders = {
      6: { id: 6, status: 'invoiced', deposit_date: '2026-10-01T08:00:00.000Z' },
      7: { id: 7, status: 'processed', deposit_date: '2026-10-01T08:00:00.000Z' },
    };
    global.strapi = { db: { query: () => ({ findOne: async ({ where }) => orders[where.id] || null }) } };
    guard = require(src('api', 'order', 'services', 'deposit-guard'));
  });

  it('refuses moving the deposit date of an invoiced order', async () => {
    expect(await guard.depositRefusal(6, { deposit_date: '2026-10-18T10:00:00Z' })).toMatch(
      /no es pot canviar la data del dipòsit/,
    );
  });

  it('lets the office save it with the date it has, and a processed order be deposited again', async () => {
    expect(await guard.depositRefusal(6, { deposit_date: '2026-10-01T08:00:00Z' })).toBeNull();
    expect(await guard.depositRefusal(7, { deposit_date: '2026-10-18T10:00:00Z' })).toBeNull();
  });
});

describe('incidence replies (issues/164)', () => {
  const stored = () => ({
    id: 50,
    incidence_response: [
      { id: 1, text: 'Ho mirem', user: { id: 9 }, response_date: '2026-10-17T09:00:00.000Z' },
    ],
  });

  function load() {
    jest.resetModules();
    const base = { update: jest.fn(async () => ({ data: {} })) };
    global.strapi = { db: { query: () => ({ findOne: async () => stored() }) } };
    mockCoreController(base);
    const ctrl = require(src('api', 'incidence', 'controllers', 'incidence'));
    return { ctrl, base };
  }

  it("keeps the stored replies and adds the new one in the sender's name", async () => {
    const { ctrl } = load();
    const ctx = {
      params: { id: 'doc50' },
      state: { user: { id: 100 }, v3: { numericId: 50 } },
      request: {
        body: {
          data: {
            incidence_response: [
              { text: 'Esborrat', user: 9 },
              { text: 'Nova', user: 9, response_date: '2020-01-01' },
            ],
          },
        },
      },
    };
    await ctrl.update(ctx);
    const replies = ctx.request.body.data.incidence_response;
    expect(replies[0]).toEqual({ id: 1, text: 'Ho mirem', user: 9, response_date: '2026-10-17T09:00:00.000Z' });
    expect(replies[1]).toMatchObject({ text: 'Nova', user: 100 });
    expect(replies[1].response_date).toBeInstanceOf(Date);
    expect(replies).toHaveLength(2);
  });

  it('can not drop the stored replies', async () => {
    const { ctrl } = load();
    const ctx = {
      params: { id: '50' },
      state: { user: { id: 100 } },
      request: { body: { incidence_response: [] } },
    };
    await ctrl.update(ctx);
    expect(ctx.request.body.incidence_response).toHaveLength(1);
  });
});

describe('response sanitizer (issues/165)', () => {
  const { sanitizeResponse, rulesFor } = require(src('services', 'response-sanitizer'));
  const strapi = {
    contentTypes: {
      'api::project.project': {
        attributes: {
          project_phases: { type: 'relation', target: 'api::project-phase.project-phase' },
          activities: { type: 'relation', target: 'api::activity.activity' },
        },
      },
      'api::project-phase.project-phase': {
        attributes: { incomes: { type: 'relation', target: 'api::phase-income.phase-income' } },
      },
      'api::phase-income.phase-income': { attributes: {} },
      'api::activity.activity': { attributes: {} },
    },
    components: {},
  };

  it("drops a project's income amounts and the activities' cost, keeping the hours", () => {
    const body = [
      {
        id: 1,
        name: 'P',
        balance: 3,
        project_phases: [{ id: 2, incomes: [{ id: 3, concept: 'Hores', amount: 50, total_amount: 500, quantity: 10 }] }],
        activities: [{ id: 4, hours: 2, cost_by_hour: 21.5, invoice_hours_price: 40 }],
        planned_hours: { '2026-10': 8 },
      },
    ];
    sanitizeResponse(strapi, 'api::project.project', body, rulesFor());
    expect(body[0]).toEqual({
      id: 1,
      name: 'P',
      project_phases: [{ id: 2, incomes: [{ id: 3, concept: 'Hores', quantity: 10 }] }],
      activities: [{ id: 4, hours: 2 }],
      planned_hours: { '2026-10': 8 },
    });
  });

  it("leaves the amounts of a member's own income lines (findAssigned)", () => {
    const body = [{ id: 3, amount: 50, total_amount: 500 }];
    sanitizeResponse(strapi, 'api::phase-income.phase-income', body, rulesFor({ member: true }));
    expect(body).toEqual([{ id: 3, amount: 50, total_amount: 500 }]);
  });

  it('leaves files alone', () => {
    const pdf = Buffer.from('%PDF');
    sanitizeResponse(strapi, 'api::project.project', pdf, rulesFor());
    expect(pdf.toString()).toBe('%PDF');
  });
});

describe('«Contacta» (issues/167)', () => {
  function load({ contactFormEmail = 'oficina@example.org', sendFails = false } = {}) {
    jest.resetModules();
    const send = jest.fn(async () => {
      if (sendFails) throw new Error('SMTP down');
    });
    const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
    global.strapi = {
      log,
      config: { get: () => 'no-reply@example.org' },
      plugin: () => ({ service: () => ({ send }) }),
      db: {
        query: () => ({
          findOne: async ({ where }) => ({ id: where.id, username: 'membre', email: 'membre@example.org' }),
        }),
      },
    };
    jest.doMock(src('services', 'me-settings'), () => ({
      getMe: async () => ({ name: 'Entitat', contact_form_email: contactFormEmail }),
    }));
    const lifecycles = require(src('api', 'form-submission', 'content-types', 'form-submission', 'lifecycles'));
    return { lifecycles, send, log };
  }

  const event = (data) => ({ params: { data }, result: { id: 7 } });

  it('mails after saving, so a mail failure no longer loses the message', async () => {
    const { lifecycles, log } = load({ sendFails: true });
    expect(lifecycles.beforeCreate).toBeUndefined();
    await expect(lifecycles.afterCreate(event({ user: 100, message: 'Hola' }))).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/message 7 failed: SMTP down/));
  });

  it('saves the message when no contact address is configured', async () => {
    const { lifecycles, send, log } = load({ contactFormEmail: '' });
    await lifecycles.afterCreate(event({ user: 100, message: 'Hola' }));
    expect(send).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("sends to the office and the sender's account, not to the typed address, escaped", async () => {
    const { lifecycles, send } = load();
    await lifecycles.afterCreate(
      event({ user: 100, email: 'victim@example.org', name: 'N', message: '<img src=x onerror=alert(1)>' }),
    );
    const mail = send.mock.calls[0][0];
    expect(mail.to).toEqual(['oficina@example.org', 'membre@example.org']);
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(mail.html).not.toContain('<img');
  });

  it('takes the sender from the session, not from the body', async () => {
    jest.resetModules();
    const base = { create: jest.fn(async () => ({ data: {} })) };
    global.strapi = {};
    mockCoreController(base);
    const ctrl = require(src('api', 'form-submission', 'controllers', 'form-submission'));
    const ctx = { state: { user: { id: 100 } }, request: { body: { data: { user: 1, message: 'x' } } } };
    await ctrl.create(ctx);
    expect(ctx.request.body.data.user).toBe(100);
  });
});

describe('delivery date rules (issues/168)', () => {
  const NOW = new Date('2026-10-18T19:37:00');

  function load({ permissions = ['orders'], stored = null } = {}) {
    jest.resetModules();
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    const base = {
      create: jest.fn(async () => ({ data: { id: 1 } })),
      update: jest.fn(async () => ({ data: { id: 1 } })),
    };
    global.strapi = {
      db: {
        query: (uid) => ({
          findOne: async ({ where }) =>
            uid === 'plugin::users-permissions.user'
              ? { id: where.id, permissions: permissions.map((permission) => ({ permission })) }
              : stored,
        }),
      },
      service: () => ({ create: jest.fn(async () => ({ id: 1 })) }),
    };
    jest.doMock(src('services', 'me-settings'), () => ({
      getMe: async () => ({ orders_options: { next_day_limit_hour: 13 } }),
      frontUrlOf: () => '',
    }));
    mockCoreController(base);
    const ctrl = require(src('api', 'order', 'controllers', 'order'));
    return { ctrl, base };
  }

  const ctxFor = (body, extra = {}) => ({
    state: { user: { id: 100 }, ...(extra.state || {}) },
    params: extra.params || {},
    request: { body },
    badRequest: jest.fn((message) => message),
  });

  it('refuses tomorrow past the cutoff in the body the front sends', async () => {
    const { ctrl, base } = load();
    const ctx = ctxFor({ data: { route: 3, contact: 4, estimated_delivery_date: '2026-10-19' } });
    await ctrl.create(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(expect.stringMatching(/hora límit \(13h\)/));
    expect(base.create).not.toHaveBeenCalled();
  });

  it.each([['2026-10-18'], ['2026-10-01']])('refuses delivering on %s', async (date) => {
    const { ctrl } = load();
    const ctx = ctxFor({ data: { route: 3, contact: 4, estimated_delivery_date: date } });
    await ctrl.create(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(expect.stringMatching(/a partir de demà/));
  });

  it('lets the office do it', async () => {
    const { ctrl, base } = load({ permissions: ['orders_admin'] });
    await ctrl.create(ctxFor({ data: { route: 3, contact: 4, estimated_delivery_date: '2026-10-19' } }));
    expect(base.create).toHaveBeenCalled();
  });

  it('creates an order without state as pending', async () => {
    const { ctrl } = load();
    const ctx = ctxFor({ data: { route: 3, contact: 4, estimated_delivery_date: '2026-10-21' } });
    await ctrl.create(ctx);
    expect(ctx.request.body.data.status).toBe('pending');
  });

  // the user's decision (2026-10-19, issues/186): every order is created pending
  it('creates every order as pending, whatever state it is sent with', async () => {
    const { ctrl } = load({ permissions: ['orders_admin'] });
    const ctx = ctxFor({ data: { route: 3, contact: 4, estimated_delivery_date: '2026-10-21', status: 'delivered' } });
    await ctrl.create(ctx);
    expect(ctx.request.body.data.status).toBe('pending');
  });

  // issues/215: a delivery point needs a trade name; the CSV import's new
  // points take their name when the file gives none
  it("gives the CSV import's new point its name as trade name when it has none", async () => {
    const { ctrl } = load({ permissions: ['orders_admin'] });
    const create = jest.fn(async () => ({ id: 9 }));
    global.strapi.service = () => ({ create });
    const ctx = ctxFor({ route: { id: 3 }, owner: { id: 100 }, contact: { name: 'Nou punt' }, estimated_delivery_date: '2026-10-21' });
    await ctrl.createCSV(ctx);
    expect(create.mock.calls[0][0].data).toMatchObject({
      name: 'Nou punt',
      trade_name: 'Nou punt',
      owner: 100,
    });
  });

  it('refuses moving an order to tomorrow past the cutoff, not saving it with its date', async () => {
    const moved = load({ stored: { id: 1, estimated_delivery_date: '2026-10-22' } });
    const ctx = ctxFor({ data: { route: 3, contact: 4, estimated_delivery_date: '2026-10-19' } }, { state: { v3: { numericId: 1 } } });
    await moved.ctrl.update(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(expect.stringMatching(/No es pot moure la comanda/));

    const same = load({ stored: { id: 1, estimated_delivery_date: '2026-10-19' } });
    const keep = ctxFor({ data: { route: 3, contact: 4, estimated_delivery_date: '2026-10-19', units: 2 } }, { state: { v3: { numericId: 1 } } });
    await same.ctrl.update(keep);
    expect(keep.badRequest).not.toHaveBeenCalled();
    expect(same.base.update).toHaveBeenCalled();
  });

  it('applies to the CSV import', async () => {
    const { ctrl } = load();
    const ctx = ctxFor({ route: { id: 3 }, contact: { id: 4 }, estimated_delivery_date: '2026-10-19' });
    await ctrl.createCSV(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(expect.stringMatching(/hora límit/));
  });
});
