'use strict';

/**
 * Integrations API (2026-10-29): La Dotzena's own system creates, updates and
 * cancels its orders and delivery points instead of the CSV import, with an
 * API key per user in the `x-api-key` header. Guards:
 *
 * - the key: only its hash is stored, a missing / unknown / revoked key is a
 *   401 that says why, the user must have `orders`, 60 requests a minute;
 * - each item is independent; an external_id twice in a request is refused;
 *   requests of one member run one at a time;
 * - an order is identified by her external_id: the same data again is
 *   `unchanged` whatever its state, a change is refused once the office took
 *   it (ORDER_LOCKED) or it was cancelled (ORDER_CANCELLED); cancelling is
 *   pending → cancelled only;
 * - a delivery point needs what the CSV import checks (NIF, phone, address,
 *   schedule of 3 h at least), but not the sector nor the legal form;
 * - an order without a route goes on the route of the point's town that runs
 *   the day asked, or the first day after (2026-10-30); the day asked again,
 *   once moved, is no change.
 */

const path = require('path');

const src = (...parts) => path.join(__dirname, '..', 'src', ...parts);

afterEach(() => {
  delete global.strapi;
  jest.dontMock(src('services', 'integrations', 'refs'));
  jest.dontMock(src('middlewares', 'app-permissions'));
  jest.dontMock(src('api', 'order', 'controllers', 'order'));
  jest.dontMock(src('services', 'app-permissions'));
  jest.dontMock(src('services', 'integrations', 'api-keys'));
});

describe('api keys (services/integrations/api-keys)', () => {
  let apiKeys;
  let created;
  beforeEach(() => {
    jest.resetModules();
    created = [];
    global.strapi = {
      db: {
        query: () => ({
          create: async ({ data }) => {
            created.push(data);
            return { id: 7, createdAt: '2026-10-29T10:00:00.000Z', ...data };
          },
          findOne: async ({ where }) =>
            where.key_hash === created[0]?.key_hash ? { id: 7, ...created[0] } : null,
          update: async () => ({}),
        }),
      },
    };
    apiKeys = require(src('services', 'integrations', 'api-keys'));
  });

  it('stores only the hash and a short prefix, and returns the key once', async () => {
    const out = await apiKeys.createKey({ userId: 65, name: ' Sistema ', createdBy: 20 });
    expect(out.key).toMatch(/^esk_[A-Za-z0-9_-]{43}$/);
    expect(created[0]).toMatchObject({
      user_id: 65,
      name: 'Sistema',
      issued_by: 20,
      prefix: out.key.slice(0, 12),
    });
    expect(created[0].key_hash).toBe(apiKeys.hashKey(out.key));
    expect(JSON.stringify(created[0])).not.toContain(out.key);
    expect(apiKeys.keyOut({ ...created[0], id: 7 })).not.toHaveProperty('key_hash');
  });

  it('authenticates the key and nothing else', async () => {
    const { key } = await apiKeys.createKey({ userId: 65 });
    expect(await apiKeys.authenticateKey(key)).toMatchObject({ id: 7, user_id: 65 });
    expect(await apiKeys.authenticateKey(`${key}x`)).toBeNull();
    expect(await apiKeys.authenticateKey('Bearer whatever')).toBeNull();
    expect(await apiKeys.authenticateKey(undefined)).toBeNull();
  });
});

describe('api-key policy', () => {
  function load({
    row = { id: 1, user_id: 65, prefix: 'esk_abc' },
    user = { id: 65, username: 'La Dotzena' },
    permissions = ['orders'],
  } = {}) {
    jest.resetModules();
    jest.doMock(src('services', 'integrations', 'api-keys'), () => ({
      authenticateKey: async (k) => (k === 'esk_good' ? row : null),
    }));
    jest.doMock(src('services', 'app-permissions'), () => ({ appPermissionsOf: async () => permissions }));
    const policy = require(src('policies', 'api-key'));
    const strapi = { db: { query: () => ({ findOne: async () => user }) } };
    const run = (key) => {
      const ctx = { request: { header: key ? { 'x-api-key': key } : {} }, state: {} };
      return policy(ctx, {}, { strapi }).then(() => ctx);
    };
    return { policy, run };
  }

  it('refuses a missing or unknown key with a 401 that says why', async () => {
    const { run } = load();
    await expect(run(null)).rejects.toMatchObject({
      status: 401,
      expose: true,
      message: expect.stringMatching(/x-api-key/),
    });
    await expect(run('esk_bad')).rejects.toMatchObject({
      status: 401,
      message: expect.stringMatching(/no és vàlida o s'ha revocat/),
    });
  });

  it('refuses a blocked user and one without the orders permission', async () => {
    await expect(load({ user: { id: 65, blocked: true } }).run('esk_good')).rejects.toMatchObject({
      status: 401,
    });
    await expect(load({ permissions: ['hours'] }).run('esk_good')).rejects.toMatchObject({
      name: 'PolicyError',
    });
  });

  it('puts the member on state.integration, not state.user', async () => {
    const ctx = await load().run('esk_good');
    expect(ctx.state.integration).toMatchObject({
      user: { id: 65 },
      permissions: ['orders'],
      key: { prefix: 'esk_abc' },
    });
    expect(ctx.state.user).toBeUndefined();
  });

  it('allows 60 requests a minute per key', () => {
    const { policy } = load();
    const t = 1_000_000;
    for (let i = 0; i < policy.RATE_LIMIT; i++) expect(policy.overLimit(99, t + i)).toBe(false);
    expect(policy.overLimit(99, t + 100)).toBe(true);
    expect(policy.overLimit(99, t + 61_000)).toBe(false);
  });
});

describe('items and results (sync-common)', () => {
  let common;
  beforeEach(() => {
    jest.resetModules();
    common = require(src('api', 'integration', 'services', 'sync-common'));
  });

  it('refuses a body without the list, an empty one and one too long', () => {
    expect(common.itemsOf({}, 'orders').error).toMatch(/llista «orders»/);
    expect(common.itemsOf({ orders: [] }, 'orders').error).toMatch(/buida/);
    expect(common.itemsOf({ orders: new Array(501).fill({}) }, 'orders').error).toMatch(/500/);
    expect(common.itemsOf({ orders: [{}] }, 'orders').items).toHaveLength(1);
  });

  it('answers each item, refuses an external_id twice and turns rule errors into rejections', async () => {
    const handled = [];
    const results = await common.runItems(
      [{ external_id: ' A ' }, { external_id: 'A' }, {}, { external_id: 'B' }, { external_id: 'C' }],
      async (item, ext) => {
        handled.push(ext);
        if (ext === 'B') common.reject('ORDER_LOCKED', 'Ja està processada', { order_id: 9 });
        if (ext === 'C') throw new Error('boom');
        return { result: 'created', order_id: 1 };
      },
      { error: () => {} },
    );
    expect(handled).toEqual(['A', 'B', 'C']);
    expect(results.map((r) => [r.external_id, r.result, r.code])).toEqual([
      ['A', 'created', undefined],
      ['A', 'rejected', 'DUPLICATE_IN_REQUEST'],
      [null, 'rejected', 'INVALID'],
      ['B', 'rejected', 'ORDER_LOCKED'],
      ['C', 'rejected', 'ERROR'],
    ]);
    expect(results[3].order_id).toBe(9);
    expect(common.summaryOf(results)).toMatchObject({ received: 5, created: 1, rejected: 4 });
  });

  it('runs the requests of one member one after the other', async () => {
    const log = [];
    const slow = (name, ms) => () =>
      new Promise((r) =>
        setTimeout(() => {
          log.push(name);
          r(name);
        }, ms),
      );
    await Promise.all([
      common.withOwnerLock(65, slow('first', 30)),
      common.withOwnerLock(65, slow('second', 1)),
    ]);
    expect(log).toEqual(['first', 'second']);
  });
});

describe('delivery points (contacts-sync)', () => {
  let sync;
  beforeEach(() => {
    jest.resetModules();
    global.strapi = {};
    sync = require(src('api', 'integration', 'services', 'contacts-sync'));
  });

  const complete = {
    name: 'Botiga',
    nif: '12345678Z',
    phone: '930000000',
    address: 'Major 1',
    postcode: '08001',
    city: 'Barcelona',
    time_slot_1_ini: 9,
    time_slot_1_end: 13,
    sector: 1,
  };

  it('reads hours as numbers, «9:30» too', () => {
    expect(sync.hourOf('9')).toBe(9);
    expect(sync.hourOf('9,5')).toBe(9.5);
    expect(sync.hourOf('13:30')).toBe(13.5);
    expect(sync.hourOf('')).toBeNull();
    expect(Number.isNaN(sync.hourOf('matí'))).toBe(true);
  });

  it('asks for what the CSV import checks and a schedule of 3 hours', () => {
    expect(() => sync.checkComplete(complete)).not.toThrow();
    // no sector nor legal form is fine (the user's decision 2026-10-30)
    expect(() => sync.checkComplete({ ...complete, sector: null, legal_form: null })).not.toThrow();
    expect(() => sync.checkComplete({ ...complete, phone: null })).toThrow(/telèfon/);
    expect(() => sync.checkComplete({ ...complete, time_slot_1_end: 11 })).toThrow(/3 hores/);
    expect(() =>
      sync.checkComplete({ ...complete, time_slot_1_end: 11, time_slot_2_ini: 16, time_slot_2_end: 19 }),
    ).not.toThrow();
    expect(() => sync.checkComplete({ ...complete, time_slot_1_ini: 14 })).toThrow(/anterior/);
  });

  it('only counts real changes (the NIF without spaces or case)', () => {
    const stored = { ...complete, nif: '12345678z', sector: { id: 1 }, time_slot_1_ini: '9.00' };
    expect(sync.changedFields({ nif: '12345678Z', sector: 1, time_slot_1_ini: 9 }, stored)).toEqual([]);
    expect(sync.changedFields({ phone: '600000000', sector: 2 }, stored)).toEqual(['phone', 'sector']);
  });
});

describe('orders (orders-sync)', () => {
  let sync;
  let updates;
  let order;
  beforeEach(() => {
    jest.resetModules();
    updates = [];
    order = {
      id: 500,
      documentId: 'doc500',
      status: 'pending',
      owner: { id: 65 },
      route: { id: 1 },
      contact: { id: 2251 },
      pickup: { id: 3 },
      delivery_type: { id: 1, refrigerated: false },
      units: 2,
      kilograms: '10.00',
      fragile: false,
      comments: 'Trucar abans',
      provider_order_number: 'O1',
      estimated_delivery_date: '2026-11-03',
      lines: [],
      price: '9.24',
    };
    jest.doMock(src('services', 'integrations', 'refs'), () => ({
      findRefs: async (_o, _k, ids) =>
        new Map(ids.filter((id) => id === 'O1').map((id) => [id, { id: 1, target: 500 }])),
      release: async () => {},
    }));
    jest.doMock(src('middlewares', 'app-permissions'), () => ({
      memberRules: { memberOwnOrderUpdate: async () => {}, memberOrderPayload: async () => {} },
    }));
    jest.doMock(src('api', 'order', 'controllers', 'order'), () => ({ orderRules: {} }));
    global.strapi = {
      db: { query: () => ({ findOne: async () => ({ ...order }) }) },
      service: () => ({
        update: async (documentId, { data }) => {
          updates.push([documentId, data]);
          Object.assign(order, data);
        },
      }),
    };
    sync = require(src('api', 'integration', 'services', 'orders-sync'));
  });

  const ctx = () => ({
    userId: 65,
    user: { id: 65 },
    permissions: ['orders'],
    dryRun: false,
    cache: {},
    lookups: {},
  });

  it('takes the day asked before it moved as no change', () => {
    // asked for Monday 2026-11-02, went on Tuesday's route
    const asked = { estimated_delivery_date: '2026-11-02' };
    expect(sync.changesOf({}, order, asked, { requestedDate: '2026-11-02' }).changed).toEqual([]);
    expect(sync.changesOf({}, order, asked, {}).changed).toEqual(['estimated_delivery_date']);
    expect(sync.changesOf({}, order, { estimated_delivery_date: '2026-11-03' }, {}).changed).toEqual([]);
  });

  it('finds no change when the same order comes again', () => {
    const wanted = {
      units: 2,
      kilograms: 10,
      fragile: false,
      comments: 'Trucar abans',
      provider_order_number: 'O1',
      lines: [],
    };
    expect(sync.changesOf(wanted, order, { estimated_delivery_date: '2026-11-03' }).changed).toEqual([]);
    expect(sync.changesOf({ ...wanted, kilograms: 12 }, order, {}).changed).toEqual(['kilograms']);
    expect(
      sync.changesOf({ lines: [{ units: 1, kilograms: 4, name: 'A', nif: null }] }, order, {}).changed,
    ).toEqual(['lines']);
  });

  it('cancels a pending order once, and says so the second time', async () => {
    expect(await sync.cancelOrder({}, 'O1', ctx())).toMatchObject({ result: 'cancelled', order_id: 500 });
    expect(updates).toEqual([['doc500', { status: 'cancelled' }]]);
    expect(await sync.cancelOrder({}, 'O1', ctx())).toMatchObject({ result: 'already_cancelled' });
    expect(await sync.cancelOrder({}, 'nope', ctx())).toMatchObject({ result: 'not_found' });
  });

  it('refuses to cancel or change an order the office has taken, but not the same data', async () => {
    order.status = 'processed';
    await expect(sync.cancelOrder({}, 'O1', ctx())).rejects.toMatchObject({ code: 'ORDER_LOCKED' });
    const same = { units: 2, kilograms: 10, notes: 'Trucar abans' };
    expect(await sync.syncOrder(same, 'O1', ctx())).toMatchObject({
      result: 'unchanged',
      status: 'processed',
    });
    await expect(sync.syncOrder({ ...same, units: 3 }, 'O1', ctx())).rejects.toMatchObject({
      code: 'ORDER_LOCKED',
    });
    order.status = 'cancelled';
    await expect(sync.syncOrder({ ...same, units: 3 }, 'O1', ctx())).rejects.toMatchObject({
      code: 'ORDER_CANCELLED',
    });
    expect(updates).toEqual([]);
  });

  it("refuses another member's order", async () => {
    order.owner = { id: 54 };
    await expect(sync.cancelOrder({}, 'O1', ctx())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('validates the lines', () => {
    expect(sync.linesOf([{ units: '2', kilograms: '3,5', name: ' Caixa ', nif: '1234 5678-z' }])).toEqual([
      { units: 2, kilograms: 3.5, name: 'Caixa', nif: '12345678Z' },
    ]);
    expect(() => sync.linesOf([{ units: 0 }])).toThrow(/més gran que 0/);
    expect(() => sync.linesOf('x')).toThrow(/llista/);
  });
});

describe('route of an order without one (route-assignment)', () => {
  let assignRouteDay;
  let closures;
  // 2026-11-03 is a Tuesday
  const routes = [
    { id: 1, name: 'DT - MARESME', active: true, tuesday: true },
    { id: 3, name: 'DC - VALLÈS', active: true, wednesday: true },
    { id: 2, name: 'DJ - MARESME', active: true, thursday: true },
    { id: 9, name: 'DT - VELLA', active: false, tuesday: true },
    { id: 8, name: 'TRANSFER', active: true, is_transfer_route: true, monday: true },
  ];
  const lookups = {
    routes: async () => routes,
    cities: async () => [
      { id: 10, name: 'Mataró' },
      { id: 11, name: 'Granollers' },
    ],
    cityRoutes: async () => [
      { city: { id: 10 }, route: { id: 1 } },
      { city: { id: 10 }, route: { id: 2 } },
      { city: { id: 10 }, route: { id: 9 } },
      { city: { id: 10 }, route: { id: 8 } },
      { city: { id: 11 }, route: { id: 3 } },
    ],
  };
  const point = { city: ' mataro ' };
  const assign = (from) => assignRouteDay(point, from, { lookups, today: '2026-10-30' });

  beforeEach(() => {
    jest.resetModules();
    closures = [];
    global.strapi = { db: { query: () => ({ findMany: async () => closures }) } };
    ({ assignRouteDay } = require(src('api', 'integration', 'services', 'route-assignment')));
  });

  it("takes the town's route of the day asked", async () => {
    expect(await assign('2026-11-03')).toMatchObject({ route: { id: 1 }, date: '2026-11-03', moved: false });
  });

  it('moves to the first day after it with a route of the town', async () => {
    // Wednesday: the Vallès route is not Mataró's
    expect(await assign('2026-11-04')).toMatchObject({ route: { id: 2 }, date: '2026-11-05', moved: true });
    // Friday → next Tuesday; Monday's transfer route and the inactive one never count
    expect(await assign('2026-11-06')).toMatchObject({ route: { id: 1 }, date: '2026-11-10', moved: true });
  });

  it('skips a closed day, or takes its substitute route', async () => {
    closures = [{ date: '2026-11-03', route: { id: 1 } }];
    expect(await assign('2026-11-03')).toMatchObject({ route: { id: 2 }, date: '2026-11-05' });
    closures = [
      { date: '2026-11-03', route: { id: 1 }, substitute_route: { id: 3 }, substitute_date: '2026-11-04' },
    ];
    expect(await assign('2026-11-03')).toMatchObject({ route: { id: 3 }, date: '2026-11-04', moved: true });
  });

  it('refuses a town without routes', async () => {
    await expect(
      assignRouteDay({ city: 'Lleida' }, '2026-11-03', { lookups, today: '2026-10-30' }),
    ).rejects.toMatchObject({
      code: 'TOWN_WITHOUT_ROUTES',
    });
  });
});
