'use strict';

/**
 * issues/314 (2026-10-21): members could see which routes go through a town,
 * but not at what time. Each route now has a usual time slot (`time_from`,
 * `time_to`) and each town in a route (city-route) can have its own one; an
 * empty `time_to` means a fixed time («a les 7 h»). The office sets them, the
 * members read them through `city-routes/basic`.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const schema = (api) =>
  JSON.parse(read('api', api, 'content-types', api, 'schema.json')).attributes;

describe('schema', () => {
  it.each([['route'], ['city-route']])('%s has an optional time slot', (api) => {
    const attrs = schema(api);
    expect(attrs.time_from).toEqual({ type: 'time' });
    expect(attrs.time_to).toEqual({ type: 'time' });
  });
});

describe('checkSlot', () => {
  const { checkSlot } = require('../src/services/time-slot');

  it.each([
    [null, null],
    ['07:00:00.000', null],
    ['09:00:00.000', '14:00:00.000'],
    ['09:30', '09:45'],
  ])('accepts %s – %s', (from, to) => {
    expect(checkSlot(from, to)).toBeNull();
  });

  it('refuses an end without a start', () => {
    expect(checkSlot(null, '14:00:00.000')).toMatch(/inici/);
  });

  it.each([
    ['14:00:00.000', '09:00:00.000'],
    ['09:00:00.000', '09:00:00.000'],
  ])('refuses %s – %s (end not after start)', (from, to) => {
    expect(checkSlot(from, to)).toMatch(/posterior/);
  });
});

describe.each([
  ['route', 'api::route.route'],
  ['city-route', 'api::city-route.city-route'],
])('%s lifecycles', (api, uid) => {
  let lifecycles;
  let existing;
  let query;

  beforeEach(() => {
    jest.resetModules();
    existing = { time_from: '09:00:00', time_to: '14:00:00' };
    query = { findOne: jest.fn(async () => existing) };
    global.strapi = { db: { query: jest.fn(() => query) } };
    lifecycles = require(`../src/api/${api}/content-types/${api}/lifecycles`);
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('creates with a valid slot', async () => {
    await expect(
      lifecycles.beforeCreate({ params: { data: { time_from: '07:00:00.000', time_to: null } } })
    ).resolves.toBeUndefined();
  });

  it('refuses to create an inverted slot', async () => {
    await expect(
      lifecycles.beforeCreate({ params: { data: { time_from: '15:00:00.000', time_to: '12:00:00.000' } } })
    ).rejects.toMatchObject({ name: 'ApplicationError' });
  });

  it('checks a partial update against the stored slot', async () => {
    await expect(
      lifecycles.beforeUpdate({ params: { where: { id: 1 }, data: { time_to: '08:00:00.000' } } })
    ).rejects.toMatchObject({ name: 'ApplicationError' });
    expect(global.strapi.db.query).toHaveBeenCalledWith(uid);
  });

  it('leaves updates that do not touch the slot alone', async () => {
    await lifecycles.beforeUpdate({ params: { where: { id: 1 }, data: { name: 'x' } } });
    expect(query.findOne).not.toHaveBeenCalled();
  });
});

describe('city-routes/basic and permissions', () => {
  it('basic returns the town slot (the route comes whole, with its own)', () => {
    const { BASIC_SELECT, BASIC_POPULATE } = require('../src/api/city-route/services/basic-shape');
    expect(BASIC_SELECT).toEqual(expect.arrayContaining(['id', 'time_from', 'time_to']));
    expect(BASIC_POPULATE.route).toBe(true);
  });

  it('logged-in users are granted city-route update (the app permissions keep it to the staff)', () => {
    expect(read('services', 'bootstrap-permissions.js')).toMatch(/'city-route': \[[^\]]*'update'/);
  });

  function middleware(permissions) {
    jest.resetModules();
    const strapi = {
      db: {
        query: jest.fn(() => ({
          findOne: jest.fn(async ({ where }) => ({
            id: where.id,
            permissions: permissions.map((permission) => ({ permission })),
          })),
        })),
      },
    };
    return require('../src/middlewares/app-permissions')({}, { strapi });
  }

  async function update(mw) {
    const ctx = {
      method: 'PUT',
      query: {},
      params: { id: 1 },
      request: { body: { data: { time_from: '07:00:00.000' } } },
      state: { user: { id: 100 }, route: { handler: 'api::city-route.city-route.update', info: { apiName: 'city-route' } } },
    };
    const next = jest.fn(async () => {});
    await mw(ctx, next);
    return next;
  }

  it.each([['orders_admin'], ['orders_delivery']])('%s sets a town slot', async (permission) => {
    expect(await update(middleware([permission]))).toHaveBeenCalled();
  });

  it('a member (orders) cannot', async () => {
    await expect(update(middleware(['orders']))).rejects.toMatchObject({ name: 'ForbiddenError' });
  });
});
