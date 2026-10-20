'use strict';

/**
 * issues/288 (2026-10-20, review 9): deleting a draft invoice set every order
 * linked to it to Lliurada, whatever its state. An order cancelled after
 * invoicing (24470 on draft 889), or moved off Facturada, came back as a
 * delivered order with no invoice and went into «Per facturar» for the next
 * run. Now only the orders still invoiced go back to delivered; the others
 * keep their state. All of them lose the invoice link. The 153 (phase income)
 * behaviour is unchanged.
 */

const path = require('path');

const LIFECYCLES = path.join(
  __dirname, '..', 'src', 'api', 'emitted-invoice', 'content-types', 'emitted-invoice', 'lifecycles.js',
);

describe('deleting a draft invoice keeps the state of orders no longer invoiced (issues/288)', () => {
  let orders;
  let rows;
  let logged;
  let deleted;

  // Tiny emulation of the two statements beforeDelete runs on the orders.
  function raw(sql, bindings) {
    const ids = bindings.map(Number);
    if (/^UPDATE orders SET/.test(sql)) {
      for (const row of rows.filter((r) => ids.includes(r.id))) {
        const guarded = /CASE WHEN status = 'invoiced' THEN 'delivered' ELSE status END/.test(sql);
        if (!guarded && !/status = 'delivered'/.test(sql)) throw new Error(`unexpected SQL ${sql}`);
        if (!guarded || row.status === 'invoiced') row.status = 'delivered';
        row.emitted_invoice_datetime = null;
      }
    } else if (/^DELETE FROM orders_emitted_invoice_lnk/.test(sql)) {
      for (const row of rows.filter((r) => ids.includes(r.id))) row.emitted_invoice = null;
    } else {
      throw new Error(`unexpected SQL ${sql}`);
    }
    return { affectedRows: ids.length };
  }

  beforeEach(() => {
    jest.resetModules();
    logged = [];
    deleted = [];
    orders = [
      { id: 1, status: 'invoiced', emitted_invoice_datetime: '2026-10-20T10:00:00.000Z' },
      { id: 2, status: 'cancelled', emitted_invoice_datetime: '2026-10-20T10:00:00.000Z' },
      { id: 3, status: 'processed', emitted_invoice_datetime: '2026-10-20T10:00:00.000Z' },
    ];
    rows = orders.map((o) => ({ ...o, emitted_invoice: 889 }));
    jest.doMock('../src/services/change-log', () => ({
      logChanges: async (uid, entries) => logged.push(...entries),
    }));
    global.strapi = {
      log: { warn: () => {}, info: () => {} },
      db: {
        query: (uid) => ({
          findOne: async () => ({ id: 889, state: 'draft', projects: [30] }),
          findMany: async () => (uid === 'api::order.order' ? orders : []),
          deleteMany: async (args) => {
            deleted.push({ uid, ...args });
            return { count: 1 };
          },
        }),
        connection: () => ({ where: () => ({ update: async () => 1 }) }),
      },
    };
    global.strapi.db.connection.raw = async (sql, bindings) => raw(sql, bindings);
  });

  afterEach(() => {
    jest.dontMock('../src/services/change-log');
    delete global.strapi;
  });

  it('sets back to delivered only the orders still invoiced', async () => {
    await require(LIFECYCLES).beforeDelete({ params: { where: { id: 889 } } });
    expect(rows.map((r) => [r.id, r.status])).toEqual([[1, 'delivered'], [2, 'cancelled'], [3, 'processed']]);
  });

  it('unlinks every order from the invoice', async () => {
    await require(LIFECYCLES).beforeDelete({ params: { where: { id: 889 } } });
    expect(rows.every((r) => r.emitted_invoice === null && r.emitted_invoice_datetime === null)).toBe(true);
  });

  it('logs a status change only for the orders that changed state', async () => {
    await require(LIFECYCLES).beforeDelete({ params: { where: { id: 889 } } });
    const statusChanges = logged.map((e) => [e.row.id, e.changes.filter((c) => c.field === 'status')]);
    expect(statusChanges).toEqual([
      [1, [{ field: 'status', from: 'invoiced', to: 'delivered' }]],
      [2, []],
      [3, []],
    ]);
    expect(logged.every((e) => e.changes.some((c) => c.field === 'emitted_invoice' && c.to === null))).toBe(true);
  });

  it('still removes the phase income of the logistics draft (issues/153)', async () => {
    await require(LIFECYCLES).beforeDelete({ params: { where: { id: 889 } } });
    expect(deleted).toEqual([{ uid: 'api::phase-income.phase-income', where: { invoice: { id: 889 } } }]);
  });
});
