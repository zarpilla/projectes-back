'use strict';

/**
 * issues/153 (2026-10-18): «Facturar» (orders/invoice) creates a draft per
 * member and an income line for it on the project's last phase. Deleting the
 * draft returned its orders to Lliurada but left the phase income behind, so
 * the project kept counting an income that was no longer invoiced. Deleting a
 * logistics draft (one with orders) now removes its phase income too; other
 * invoices keep the planned incomes they are linked to.
 */

const path = require('path');

const LIFECYCLES = path.join(
  __dirname, '..', 'src', 'api', 'emitted-invoice', 'content-types', 'emitted-invoice', 'lifecycles.js',
);

describe('deleting a logistics draft (issues/153)', () => {
  let deleted;
  let orders;

  beforeEach(() => {
    jest.resetModules();
    deleted = [];
    orders = [{ id: 1 }, { id: 2 }];
    global.strapi = {
      log: { warn: () => {}, info: () => {} },
      db: {
        query: (uid) => ({
          findOne: async () => ({ id: 55, state: 'draft', projects: [30] }),
          findMany: async () => (uid === 'api::order.order' ? orders : []),
          deleteMany: async (args) => {
            deleted.push({ uid, ...args });
            return { count: 1 };
          },
        }),
        connection: () => ({ where: () => ({ update: async () => 1 }) }),
      },
    };
    global.strapi.db.connection.raw = async () => ({ affectedRows: 1 });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('removes the income the run added to the phase', async () => {
    await require(LIFECYCLES).beforeDelete({ params: { where: { id: 55 } } });
    expect(deleted).toEqual([{ uid: 'api::phase-income.phase-income', where: { invoice: { id: 55 } } }]);
  });

  it('leaves the incomes of an invoice without orders alone', async () => {
    orders = [];
    await require(LIFECYCLES).beforeDelete({ params: { where: { id: 55 } } });
    expect(deleted).toEqual([]);
  });
});
