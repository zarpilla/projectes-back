'use strict';

/**
 * issues/326 — `GET /api/contacts/withorders` (ContactsTable «Punts
 * d'entrega», the unify modal, ContactsUserForm's can_edit) held the
 * diligencia backend 11 s at the median and up to 25 s (Loki, 14 days to
 * 2026-10-23). It loaded every order the user owns, whole, with its contact
 * populated, and counted them in JavaScript.
 *
 * These tests run the controller against real SQL (in-memory SQLite with the
 * tables Strapi 5 gives the order relations) and guard that:
 * - the counts and `can_edit` come from one grouped query, and the orders are
 *   never loaded row by row through the entity layer;
 * - the answer keeps its shape: the contact as /basic gives it (same
 *   populate), plus `num_orders` and `can_edit`;
 * - `?contact_id=` narrows to that contact (ContactsUserForm).
 */

const knexLib = require('knex');
const { BASIC_POPULATE } = require('../src/api/contact/services/contact-populate');

const ORDER = 'api::order.order';

const ORDER_META = {
  tableName: 'orders',
  attributes: {
    owner: {
      joinTable: {
        name: 'orders_owner_lnk',
        joinColumn: { name: 'order_id' },
        inverseJoinColumn: { name: 'user_id' },
      },
    },
    contact: {
      joinTable: {
        name: 'orders_contact_lnk',
        joinColumn: { name: 'order_id' },
        inverseJoinColumn: { name: 'contact_id' },
      },
    },
  },
};

const CONTACTS = [
  { id: 10, name: 'Botiga A', trade_name: 'A', sector: { id: 1, name: 'Botiga' } },
  { id: 11, name: 'Botiga B', trade_name: 'B', sector: null },
  { id: 12, name: 'Botiga C', trade_name: 'C', sector: null },
];

// [order id, status, owner, contact]
const ORDERS = [
  [1, 'pending', 7, 11],
  [2, 'pending', 7, 10],
  [3, 'invoiced', 7, 10],
  [4, 'pending', 7, 11],
  [5, 'delivered', 8, 11], // another user's
  [6, 'delivered', 8, 12], // another user's
  [7, 'pending', 7, null], // without contact
  [8, 'cancelled', 7, 11],
];

let knex;

beforeAll(async () => {
  knex = knexLib({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await knex.schema.createTable('orders', (t) => {
    t.integer('id').primary();
    t.string('status');
    t.text('notes'); // stands for the order's many columns
  });
  await knex.schema.createTable('orders_owner_lnk', (t) => {
    t.increments('id');
    t.integer('order_id');
    t.integer('user_id');
  });
  await knex.schema.createTable('orders_contact_lnk', (t) => {
    t.increments('id');
    t.integer('order_id');
    t.integer('contact_id');
  });
  for (const [id, status, owner, contact] of ORDERS) {
    await knex('orders').insert({ id, status, notes: 'x' });
    await knex('orders_owner_lnk').insert({ order_id: id, user_id: owner });
    if (contact) await knex('orders_contact_lnk').insert({ order_id: id, contact_id: contact });
  }
});

afterAll(() => knex.destroy());

beforeEach(() => jest.resetModules());

function setup() {
  const orderFindMany = jest.fn(async ({ where }) =>
    // what the entity layer would give: the user's orders, contact populated
    ORDERS.filter(([, , owner, contact]) => owner === where.owner && (!where.contact || contact === Number(where.contact)))
      .map(([id, status, , contact]) => ({ id, status, notes: 'x', contact: CONTACTS.find((c) => c.id === contact) || null })),
  );
  const contactFindMany = jest.fn(async ({ where }) => CONTACTS.filter((c) => where.id.$in.includes(c.id)));
  const strapi = {
    db: {
      connection: knex,
      metadata: { get: (uid) => (uid === ORDER ? ORDER_META : null) },
      query: jest.fn((uid) => (uid === ORDER ? { findMany: orderFindMany } : { findMany: contactFindMany })),
    },
  };
  global.strapi = strapi;
  jest.doMock('@strapi/strapi', () => ({
    factories: { createCoreController: (_uid, cfg) => cfg({ strapi }) },
  }));
  const controller = require('../src/api/contact/controllers/contact');
  return { controller, strapi, orderFindMany, contactFindMany };
}

const call = (controller, query = {}, userId = 7) =>
  controller.withorders({ query, state: { user: { id: userId } } });

describe('contacts/withorders (issues/326)', () => {
  it('counts the user’s orders per contact, with can_edit, in first-order order', async () => {
    const { controller } = setup();
    const body = await call(controller);
    expect(body).toEqual([
      { ...CONTACTS[1], num_orders: 3, can_edit: false },
      { ...CONTACTS[0], num_orders: 2, can_edit: true },
    ]);
  });

  it('never loads the orders through the entity layer', async () => {
    const { controller, orderFindMany, strapi } = setup();
    await call(controller);
    expect(orderFindMany).not.toHaveBeenCalled();
    expect(strapi.db.query).not.toHaveBeenCalledWith(ORDER);
  });

  it('reads each contact once, with the /basic relations', async () => {
    const { controller, contactFindMany } = setup();
    await call(controller);
    expect(contactFindMany).toHaveBeenCalledTimes(1);
    const [{ where, populate }] = contactFindMany.mock.calls[0];
    expect(where.id.$in.sort()).toEqual([10, 11]);
    expect(populate).toEqual(BASIC_POPULATE);
  });

  it('?contact_id narrows to that contact (ContactsUserForm)', async () => {
    const { controller } = setup();
    expect(await call(controller, { contact_id: '10' })).toEqual([{ ...CONTACTS[0], num_orders: 2, can_edit: true }]);
    expect(await call(controller, { contact_id: '12' })).toEqual([]);
  });

  it('a user without orders gets an empty list without reading contacts', async () => {
    const { controller, contactFindMany } = setup();
    expect(await call(controller, {}, 99)).toEqual([]);
    expect(contactFindMany).not.toHaveBeenCalled();
  });

  it('delivered orders of another owner do not make the contact editable', async () => {
    const { controller } = setup();
    expect(await call(controller, { contact_id: '11' })).toEqual([{ ...CONTACTS[1], num_orders: 3, can_edit: false }]);
  });
});
