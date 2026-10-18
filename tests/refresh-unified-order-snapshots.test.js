'use strict';

/**
 * issues/157 — startup script that refreshes the contact_* data of orders
 * moved to another point before the fix (Unificar, or the quick edit), which
 * still carry the old point's address.
 */
const point = (id, name, address, extra = {}) => ({
  id,
  name,
  trade_name: null,
  nif: null,
  address,
  postcode: '08001',
  notes: null,
  phone: null,
  city: 'Barcelona',
  time_slot_1_ini: null,
  time_slot_1_end: null,
  time_slot_2_ini: null,
  time_slot_2_end: null,
  pickup_discount: null,
  legal_form: null,
  ...extra,
});

const snap = (p, extra = {}) => ({
  contact_name: p.name,
  contact_address: p.address,
  contact_postcode: p.postcode,
  contact_city: p.city,
  ...extra,
});

// 1 was unified into 2 (left in place before the fix); 3 has no duplicate
const p1 = point(1, 'Fruites Marta', 'C/ Vell 1');
const p2 = point(2, 'Fruites Marta SL', 'C/ Nou 2', { phone: '600', legal_form: 2, pickup_discount: 5 });
const p3 = point(3, 'Forn Pere', 'Pl. Major 3');

describe('selectStaleSnapshots (issues/157)', () => {
  const { selectStaleSnapshots } = require('../src/services/refresh-unified-order-snapshots');
  const contacts = [p1, p2, p3];

  it("picks an order whose data is another existing point's, not its own", () => {
    const stale = selectStaleSnapshots([{ id: 10, contact: 2, ...snap(p1) }], contacts);
    expect(stale).toEqual([{ id: 10, contact: 2, matches: [1] }]);
  });

  it('ignores whitespace, case and accents', () => {
    const order = {
      id: 11,
      contact: 2,
      ...snap(p1, { contact_name: ' FRUITES  marta ', contact_address: 'c/ vell 1 ', contact_city: 'barcelona' }),
    };
    expect(selectStaleSnapshots([order], contacts).map((o) => o.id)).toEqual([11]);
  });

  it("leaves orders that carry their own point's data", () => {
    // also when other fields (phone, notes) were edited by hand
    const order = { id: 12, contact: 2, ...snap(p2, { contact_phone: '999' }) };
    expect(selectStaleSnapshots([order], contacts)).toEqual([]);
  });

  it("leaves orders whose data is no point's (hand edits)", () => {
    const order = { id: 13, contact: 3, ...snap(p3, { contact_address: 'Pl. Major 3, 2n' }) };
    expect(selectStaleSnapshots([order], contacts)).toEqual([]);
  });

  it('leaves orders without a point, or whose point is gone', () => {
    const orders = [
      { id: 14, contact: null, ...snap(p1) },
      { id: 15, contact: 99, ...snap(p1) },
    ];
    expect(selectStaleSnapshots(orders, contacts)).toEqual([]);
  });

  it('needs a name and an address to match: empty data matches nothing', () => {
    const blank = point(4, '', '');
    const other = point(5, '', '');
    const orders = [{ id: 16, contact: 4, ...snap(other) }];
    expect(selectStaleSnapshots(orders, [blank, other])).toEqual([]);
  });

  it('leaves an order whose point and the other point have the same data', () => {
    const twin = point(6, p1.name, p1.address);
    const orders = [{ id: 17, contact: 6, ...snap(p1) }];
    expect(selectStaleSnapshots(orders, [p1, twin])).toEqual([]);
  });
});

describe('refreshUnifiedOrderSnapshots (issues/157)', () => {
  let updates;
  let deleted;
  let inserted;

  const contactRows = [p1, p2, p3].map(({ legal_form: _legalForm, ...row }) => row);
  const legalFormLinks = [{ contact_id: 2, legal_form_id: 2 }];
  const orderRows = [
    { id: 10, ...snap(p1) }, // moved from 1 to 2: refreshed
    { id: 12, ...snap(p2) }, // already right
    { id: 13, ...snap(p3, { contact_address: 'Pl. Major 3, 2n' }) }, // hand edit
  ];
  const orderContactLinks = [
    { order_id: 10, contact_id: 2 },
    { order_id: 12, contact_id: 2 },
    { order_id: 13, contact_id: 3 },
  ];

  const joinTable = (name, joinColumn, inverseJoinColumn) => ({
    joinTable: { name, joinColumn: { name: joinColumn }, inverseJoinColumn: { name: inverseJoinColumn } },
  });

  // A knex-like builder over in-memory tables
  function builder(table) {
    const tables = {
      contacts: contactRows,
      orders: orderRows,
      contacts_legal_form_lnk: legalFormLinks,
      orders_contact_lnk: orderContactLinks,
    };
    const state = { where: null, whereIn: null, gt: null, limit: Infinity };
    const rows = () =>
      (tables[table] || [])
        .filter((r) => !state.gt || r[state.gt[0]] > state.gt[1])
        .filter((r) => !state.whereIn || state.whereIn[1].includes(r[state.whereIn[0]]))
        .slice(0, state.limit);
    const b = {
      select: () => b,
      orderBy: () => b,
      where: (col, op, val) => {
        if (typeof col === 'object') state.where = col;
        else state.gt = [col, val];
        return b;
      },
      whereIn: (col, vals) => {
        state.whereIn = [col, vals];
        return b;
      },
      limit: (n) => {
        state.limit = n;
        return b;
      },
      update: async (data) => updates.push({ table, where: state.where, data }),
      del: async () => deleted.push({ table, where: state.where }),
      insert: async (row) => inserted.push({ table, row }),
      then: (res, rej) => Promise.resolve(rows()).then(res, rej),
    };
    return b;
  }

  beforeEach(() => {
    jest.resetModules();
    updates = [];
    deleted = [];
    inserted = [];
    global.strapi = {
      log: { info: jest.fn() },
      db: {
        connection: jest.fn(builder),
        metadata: {
          get: (uid) =>
            uid === 'api::order.order'
              ? {
                  tableName: 'orders',
                  attributes: {
                    contact: joinTable('orders_contact_lnk', 'order_id', 'contact_id'),
                    contact_legal_form: joinTable('orders_contact_legal_form_lnk', 'order_id', 'legal_form_id'),
                  },
                }
              : {
                  tableName: 'contacts',
                  attributes: { legal_form: joinTable('contacts_legal_form_lnk', 'contact_id', 'legal_form_id') },
                },
        },
      },
    };
  });

  it("writes the current point's data on the moved order only", async () => {
    const { refreshUnifiedOrderSnapshots } = require('../src/services/refresh-unified-order-snapshots');
    const changed = await refreshUnifiedOrderSnapshots();

    expect(changed.map((c) => c.id)).toEqual([10]);
    expect(updates).toEqual([
      {
        table: 'orders',
        where: { id: 10 },
        data: expect.objectContaining({
          contact_name: 'Fruites Marta SL',
          contact_address: 'C/ Nou 2',
          contact_phone: '600',
          contact_pickup_discount: 5,
        }),
      },
    ]);
    expect(updates[0].data).not.toHaveProperty('contact_legal_form');
    expect(deleted).toEqual([{ table: 'orders_contact_legal_form_lnk', where: { order_id: 10 } }]);
    expect(inserted).toEqual([{ table: 'orders_contact_legal_form_lnk', row: { order_id: 10, legal_form_id: 2 } }]);
    expect(global.strapi.log.info).toHaveBeenCalledWith(expect.stringContaining('#10'));
  });
});
