'use strict';

/**
 * 2026-10-25 — «Punts d'entrega» on diligencia showed the plain contacts
 * table and froze for seconds before the office columns came in. Most of the
 * wait was GET /api/contacts/orders: it loaded every order of the last year
 * (~13,500), whole, with contact and owner populated, and matched each one
 * to its point with a linear search (1.7 s on a local copy, more on the VPS).
 *
 * These tests run the endpoint against real SQL (in-memory SQLite with the
 * link tables Strapi 5 gives the order relations) and guard that:
 * - the orders are never loaded through the entity layer;
 * - num_orders counts the orders of the last year per point;
 * - owners are the members who placed them, in first-order order, once each;
 * - routes come from the city routes of the point's town;
 * - the answer keeps its shape for ContactsTable.
 */

const knexLib = require('knex');

const ORDER = 'api::order.order';
const CONTACT = 'api::contact.contact';
const USER = 'plugin::users-permissions.user';

const META = {
  [ORDER]: {
    tableName: 'orders',
    attributes: {
      owner: { joinTable: { name: 'orders_owner_lnk', joinColumn: { name: 'order_id' }, inverseJoinColumn: { name: 'user_id' } } },
      contact: { joinTable: { name: 'orders_contact_lnk', joinColumn: { name: 'order_id' }, inverseJoinColumn: { name: 'contact_id' } } },
    },
  },
  [USER]: { tableName: 'up_users' },
};

const NOW = new Date('2026-10-25T10:00:00Z');

const POINTS = [
  { id: 10, trade_name: 'A', city: 'Girona' },
  { id: 11, trade_name: 'B', city: 'Palafrugell' },
  { id: 12, trade_name: 'C', city: 'Nowhere' },
];

const CITY_ROUTES = [
  { id: 1, city: { name: 'Girona' }, route: { name: 'R1' } },
  { id: 2, city: { name: 'Girona' }, route: { name: 'R2' } },
  { id: 3, city: { name: 'Palafrugell' }, route: { name: 'DJ' } },
  { id: 4, city: null, route: { name: 'R3' } },
];

// [order id, estimated delivery date, owner, contact]
const ORDERS = [
  [1, '2026-10-01', 8, 10],
  [2, '2026-09-01', 7, 10],
  [3, '2026-08-01', 8, 10],
  [4, '2025-10-25', 7, 11], // exactly one year ago: counts
  [5, '2025-10-24', 9, 11], // older: does not count
  [6, '2026-10-20', null, 11], // without owner: counts, no member
  [7, '2026-10-20', 7, null], // without point
  [8, '2026-10-20', 7, 99], // a point without owner (not listed)
];

let knex;

beforeAll(async () => {
  knex = knexLib({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await knex.schema.createTable('orders', (t) => {
    t.integer('id').primary();
    t.date('estimated_delivery_date');
    t.text('notes');
  });
  await knex.schema.createTable('orders_owner_lnk', (t) => { t.increments('id'); t.integer('order_id'); t.integer('user_id'); });
  await knex.schema.createTable('orders_contact_lnk', (t) => { t.increments('id'); t.integer('order_id'); t.integer('contact_id'); });
  await knex.schema.createTable('up_users', (t) => { t.integer('id').primary(); t.string('username'); });
  await knex('up_users').insert([{ id: 7, username: 'Pollastres' }, { id: 8, username: 'DeBosc' }, { id: 9, username: 'Vell' }]);
  for (const [id, date, owner, contact] of ORDERS) {
    await knex('orders').insert({ id, estimated_delivery_date: date, notes: 'x' });
    if (owner) await knex('orders_owner_lnk').insert({ order_id: id, user_id: owner });
    if (contact) await knex('orders_contact_lnk').insert({ order_id: id, contact_id: contact });
  }
});

afterAll(() => knex.destroy());

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers({ now: NOW, doNotFake: ['setImmediate', 'nextTick', 'setTimeout'] });
});
afterEach(() => jest.useRealTimers());

function setup() {
  const orderFindMany = jest.fn(async () => []);
  const contactFindMany = jest.fn(async () => POINTS.map((p) => ({ ...p })));
  const cityRouteFindMany = jest.fn(async () => CITY_ROUTES);
  const byUid = {
    [ORDER]: { findMany: orderFindMany },
    [CONTACT]: { findMany: contactFindMany },
    'api::city-route.city-route': { findMany: cityRouteFindMany },
  };
  const strapi = {
    db: {
      connection: knex,
      metadata: { get: (uid) => META[uid] },
      query: jest.fn((uid) => byUid[uid]),
    },
  };
  global.strapi = strapi;
  jest.doMock('@strapi/strapi', () => ({
    factories: { createCoreController: (_uid, cfg) => cfg({ strapi }) },
  }));
  const controller = require('../src/api/contact/controllers/contact');
  return { controller, strapi, orderFindMany, contactFindMany };
}

describe('contacts/orders', () => {
  it('counts, members and routes per delivery point', async () => {
    const { controller } = setup();
    const body = await controller.orders({ query: {} });
    expect(body).toEqual([
      {
        id: 10, trade_name: 'A', num_orders: 3,
        routes: ['R1', 'R2'], routes_flattened: 'R1, R2',
        owners: [{ id: 8, name: 'DeBosc' }, { id: 7, name: 'Pollastres' }],
        owners_flattened: 'DeBosc, Pollastres',
      },
      {
        id: 11, trade_name: 'B', num_orders: 2,
        routes: ['DJ'], routes_flattened: 'DJ',
        owners: [{ id: 7, name: 'Pollastres' }],
        owners_flattened: 'Pollastres',
      },
      {
        id: 12, trade_name: 'C', num_orders: 0,
        routes: [], routes_flattened: '',
        owners: [], owners_flattened: '',
      },
    ]);
  });

  it('never loads the orders through the entity layer', async () => {
    const { controller, strapi, orderFindMany } = setup();
    await controller.orders({ query: {} });
    expect(orderFindMany).not.toHaveBeenCalled();
    expect(strapi.db.query).not.toHaveBeenCalledWith(ORDER);
  });

  it('reads only the delivery points, with the few fields it uses', async () => {
    const { controller, contactFindMany } = setup();
    await controller.orders({ query: {} });
    expect(contactFindMany).toHaveBeenCalledTimes(1);
    const [{ where, select, populate }] = contactFindMany.mock.calls[0];
    expect(where).toEqual({ owner: { $notNull: true } });
    expect(select).toEqual(['id', 'trade_name', 'city']);
    expect(populate).toBeUndefined();
  });
});
