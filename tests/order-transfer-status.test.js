'use strict';

/**
 * issues/222 (2026-10-19, review 5): «Transferències» (the QR scanner) and the
 * API started and ended transfers on cancelled (24770) and invoiced (24692)
 * orders: 200, `transfer_start_date/user` set. Like the deposit (issues/149),
 * a cancelled or invoiced order can't start or end a transfer, for drivers
 * and the office alike (the guard is in the order update); clearing a move or
 * saving the dates the order already has is left alone.
 */

describe('transfer guard (issues/222)', () => {
  let guard;
  let orders;
  const now = '2026-10-19T10:00:00Z';

  beforeEach(() => {
    jest.resetModules();
    orders = {
      1: { id: 1, status: 'pending' },
      2: { id: 2, status: 'processed', transfer_start_date: '2026-10-18T08:00:00.000Z' },
      3: { id: 3, status: 'delivered', transfer_start_date: '2026-10-18T08:00:00.000Z' },
      4: { id: 4, status: 'invoiced' },
      5: { id: 5, status: 'cancelled' },
      6: { id: 6, status: 'invoiced', transfer_start_date: '2026-10-18T08:00:00.000Z' },
    };
    global.strapi = {
      db: { query: () => ({ findOne: async ({ where }) => orders[where.id] || null }) },
    };
    guard = require('../src/api/order/services/deposit-guard');
  });

  it('lets a pending, processed or delivered order start and end its transfer', async () => {
    expect(await guard.transferRefusal(1, { transfer_start_date: now })).toBeNull();
    expect(await guard.transferRefusal(2, { transfer_end_date: now })).toBeNull();
    expect(await guard.transferRefusal(3, { transfer_end_date: now })).toBeNull();
  });

  it.each([
    [4, 'transfer_start_date', /facturada: no es pot iniciar la transferència/],
    [5, 'transfer_start_date', /anul·lada: no es pot iniciar la transferència/],
    [6, 'transfer_end_date', /facturada: no es pot finalitzar la transferència/],
  ])('refuses order %s moving %s', async (id, field, message) => {
    expect(await guard.transferRefusal(id, { [field]: now })).toMatch(message);
  });

  it('refuses moving the date of a transfer already started', async () => {
    expect(await guard.transferRefusal(6, { transfer_start_date: now })).toMatch(/no es pot iniciar/);
  });

  it('leaves alone the undo, the dates the order has and other fields', async () => {
    expect(await guard.transferRefusal(6, { transfer_start_date: null, transfer_start_user: null })).toBeNull();
    expect(await guard.transferRefusal(6, { transfer_start_date: '2026-10-18T08:00:00.000Z' })).toBeNull();
    expect(await guard.transferRefusal(5, { incidences: [] })).toBeNull();
  });

  it('the order update answers 400 instead of saving', async () => {
    const ct = { uid: 'api::order.order', modelName: 'order', apiName: 'order', kind: 'collectionType', attributes: {} };
    Object.assign(global.strapi, { contentType: () => ct, contentTypes: { 'api::order.order': ct } });
    const ctrl = require('../src/api/order/controllers/order.js')({ strapi: global.strapi });
    const ctx = {
      params: { id: 'doc5' },
      state: { user: { id: 9 }, v3: { numericId: 5 } },
      request: { body: { transfer_start_date: now, transfer_start_user: 9 } },
      badRequest: jest.fn((msg) => msg),
    };
    await ctrl.update(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(expect.stringMatching(/anul·lada: no es pot iniciar la transferència/));
  });
});
