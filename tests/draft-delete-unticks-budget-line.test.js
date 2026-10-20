'use strict';

/**
 * issues/271 (2026-10-20): deleting a draft invoice (not a logistics one)
 * left the budget line it had been associated with ticked as invoiced
 * (phase_income 999, paid = 1) with no document, so it dropped out of the
 * treasury forecast (only pending lines) and showed the «Document» tag. The
 * line now goes back to not invoiced; a line that also has a received income
 * keeps that document and its tick. Logistics drafts still delete their
 * income line (issues/153).
 */

const path = require('path');

const LIFECYCLES = path.join(
  __dirname, '..', 'src', 'api', 'emitted-invoice', 'content-types', 'emitted-invoice', 'lifecycles.js',
);

describe('deleting a draft unticks its budget lines (issues/271)', () => {
  let updated;
  let deleted;
  let orders;
  let incomes;

  beforeEach(() => {
    jest.resetModules();
    updated = [];
    deleted = [];
    orders = [];
    incomes = [
      { id: 999, paid: true, income: null },
      { id: 1000, paid: true, income: { id: 7 } },
    ];
    global.strapi = {
      log: { warn: () => {}, info: () => {} },
      db: {
        query: (uid) => ({
          findOne: async () => ({ id: 55, state: 'draft', projects: [30] }),
          findMany: async (args) => {
            if (uid === 'api::order.order') return orders;
            if (uid === 'api::phase-income.phase-income' && args.where.invoice.id === 55) return incomes;
            return [];
          },
          update: async (args) => {
            updated.push({ uid, ...args });
            return {};
          },
          deleteMany: async (args) => {
            deleted.push({ uid, ...args });
            return { count: 1 };
          },
        }),
      },
    };
    global.strapi.db.connection = { raw: async () => ({ affectedRows: 1 }) };
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('sets the associated lines back to not invoiced', async () => {
    await require(LIFECYCLES).beforeDelete({ params: { where: { id: 55 } } });
    expect(deleted).toEqual([]);
    expect(updated).toEqual([
      { uid: 'api::phase-income.phase-income', where: { id: 999 }, data: { paid: false, invoice: null } },
      { uid: 'api::phase-income.phase-income', where: { id: 1000 }, data: { invoice: null } },
    ]);
  });

  it('still deletes the income line of a logistics draft (issues/153)', async () => {
    orders = [{ id: 1 }];
    await require(LIFECYCLES).beforeDelete({ params: { where: { id: 55 } } });
    expect(deleted).toEqual([{ uid: 'api::phase-income.phase-income', where: { invoice: { id: 55 } } }]);
    expect(updated).toEqual([]);
  });
});
