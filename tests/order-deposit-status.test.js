'use strict';

/**
 * issues/149 (2026-10-18): scanning an albarà QR on «Dipòsits» marked any
 * order as deposited, delivered, invoiced or cancelled ones included, and the
 * API took any `deposit_date`. An order is deposited only while it is still
 * on its way (not delivered, invoiced or cancelled); clearing a deposit or
 * saving an order that was already deposited is left alone.
 */

describe('deposit guard (issues/149)', () => {
  let guard;
  let orders;

  beforeEach(() => {
    jest.resetModules();
    orders = {
      1: { id: 1, status: 'pending', deposit_date: null },
      2: { id: 2, status: 'processed', deposit_date: null },
      3: { id: 3, status: 'delivered', deposit_date: null },
      4: { id: 4, status: 'invoiced', deposit_date: null },
      5: { id: 5, status: 'cancelled', deposit_date: null },
      6: { id: 6, status: 'delivered', deposit_date: '2026-10-01T08:00:00.000Z' },
    };
    global.strapi = {
      db: { query: () => ({ findOne: async ({ where }) => orders[where.id] || null }) },
    };
    guard = require('../src/api/order/services/deposit-guard');
  });

  it('lets a pending or processed order be deposited', async () => {
    expect(await guard.depositRefusal(1, { deposit_date: '2026-10-18T10:00:00Z' })).toBeNull();
    expect(await guard.depositRefusal(2, { deposit_date: '2026-10-18T10:00:00Z' })).toBeNull();
  });

  it.each([[3], [4], [5]])('refuses depositing order %s', async (id) => {
    expect(await guard.depositRefusal(id, { deposit_date: '2026-10-18T10:00:00Z' })).toMatch(/no es pot dipositar/);
  });

  it('leaves alone the undo and orders already deposited', async () => {
    expect(await guard.depositRefusal(3, { deposit_date: null })).toBeNull();
    expect(await guard.depositRefusal(6, { deposit_date: '2026-10-18T10:00:00Z' })).toBeNull();
    expect(await guard.depositRefusal(4, { price: 3 })).toBeNull();
  });

  it('the order update answers 400 instead of saving', async () => {
    const ct = { uid: 'api::order.order', modelName: 'order', apiName: 'order', kind: 'collectionType', attributes: {} };
    Object.assign(global.strapi, { contentType: () => ct, contentTypes: { 'api::order.order': ct } });
    const ctrl = require('../src/api/order/controllers/order.js')({ strapi: global.strapi });
    const ctx = {
      params: { id: 'doc3' },
      state: { user: { id: 9 }, v3: { numericId: 3 } },
      request: { body: { data: { deposit_date: '2026-10-18T10:00:00Z' } } },
      badRequest: jest.fn((msg) => msg),
    };
    await ctrl.update(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(expect.stringMatching(/no es pot dipositar/));
  });
});
