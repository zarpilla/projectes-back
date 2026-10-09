'use strict';

/**
 * issues/001 (2026-10-08): the payment method ("mètode de cobrament") of an
 * emitted invoice could not be corrected after emission, although the payment
 * sometimes reaches a different bank than expected. A non-updatable invoice
 * refused every save.
 *
 * PUT /api/emitted-invoices/:id/payment-method changes only the payment method
 * and the bank account derived from it (the treasury groups by bank account),
 * through the document service so the change log records it. Guards: it works
 * on a real, non-updatable invoice; nothing else on the invoice moves; a plain
 * update of a non-updatable invoice is still refused.
 */

const path = require('path');

const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'emitted-invoice', 'controllers', 'emitted-invoice.js');
const LIFECYCLES = path.join(
  __dirname, '..', 'src', 'api', 'emitted-invoice', 'content-types', 'emitted-invoice', 'lifecycles.js',
);
const UID = 'api::emitted-invoice.emitted-invoice';
const PM_UID = 'api::payment-method.payment-method';

const realInvoice = () => ({
  id: 7,
  documentId: 'doc7',
  code: 'F-0007',
  state: 'real',
  updatable: false,
  comments: 'original',
  payment_method: { id: 1, name: 'Transferència Banc A' },
});

const PAYMENT_METHODS = {
  1: { id: 1, name: 'Transferència Banc A', bank_account: { id: 10 } },
  2: { id: 2, name: 'Transferència Banc B', bank_account: { id: 20 } },
  3: { id: 3, name: 'Efectiu', bank_account: null },
};

function mockStrapi({ invoice = realInvoice() } = {}) {
  const update = jest.fn(async () => ({}));
  const ct = { uid: UID, kind: 'collectionType', attributes: {}, options: {} };
  global.strapi = {
    contentType: () => ct,
    contentTypes: { [UID]: ct },
    db: {
      query: jest.fn((uid) => {
        if (uid === PM_UID) {
          return { findOne: jest.fn(async ({ where }) => PAYMENT_METHODS[where.id] || null) };
        }
        return { findOne: jest.fn(async ({ where }) => (invoice && invoice.id === where.id ? invoice : null)) };
      }),
    },
    documents: jest.fn(() => ({ update })),
  };
  return { update };
}

function buildCtx({ id = '7', body = {}, user = { id: 5 } } = {}) {
  const ctx = {
    params: { id },
    request: { body },
    state: { user },
    badRequest: jest.fn((msg) => ({ status: 400, msg })),
    notFound: jest.fn((msg) => ({ status: 404, msg })),
  };
  return ctx;
}

describe('emitted-invoice updatePaymentMethod (issues/001)', () => {
  let ctrl;

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    delete global.strapi;
  });

  const load = () => {
    ctrl = require(CONTROLLER)({ strapi: global.strapi });
  };

  it('changes the payment method and its bank account on a real, non-updatable invoice', async () => {
    const { update } = mockStrapi();
    load();

    await ctrl.updatePaymentMethod(buildCtx({ body: { payment_method: 2 } }));

    expect(global.strapi.documents).toHaveBeenCalledWith(UID);
    expect(update).toHaveBeenCalledWith({
      documentId: 'doc7',
      data: { payment_method: 2, bank_account: 20, updatable_admin: true, user_last: 5 },
    });
  });

  it('clears the bank account when the new method has none', async () => {
    const { update } = mockStrapi();
    load();

    await ctrl.updatePaymentMethod(buildCtx({ body: { data: { payment_method: 3 } } }));

    expect(update.mock.calls[0][0].data).toMatchObject({ payment_method: 3, bank_account: null });
  });

  it('writes nothing when the method does not change', async () => {
    const { update } = mockStrapi();
    load();

    await ctrl.updatePaymentMethod(buildCtx({ body: { payment_method: 1 } }));

    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a missing or unknown payment method and an unknown invoice', async () => {
    const { update } = mockStrapi();
    load();

    const noMethod = buildCtx({ body: {} });
    await ctrl.updatePaymentMethod(noMethod);
    expect(noMethod.badRequest).toHaveBeenCalled();

    const unknownMethod = buildCtx({ body: { payment_method: 99 } });
    await ctrl.updatePaymentMethod(unknownMethod);
    expect(unknownMethod.badRequest).toHaveBeenCalled();

    const unknownInvoice = buildCtx({ id: '404', body: { payment_method: 2 } });
    await ctrl.updatePaymentMethod(unknownInvoice);
    expect(unknownInvoice.notFound).toHaveBeenCalled();

    expect(update).not.toHaveBeenCalled();
  });
});

describe('emitted-invoice beforeUpdate with the payment-method payload (issues/001)', () => {
  let lifecycles;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../src/api/project/services/totalsRefreshScheduler', () => ({
      scheduleFromEntityProjects: jest.fn(),
    }));
    global.strapi = {
      db: {
        query: jest.fn((uid) => ({
          findOne: jest.fn(async ({ where }) => (uid === PM_UID ? PAYMENT_METHODS[where.id] : realInvoice())),
        })),
      },
    };
    lifecycles = require(LIFECYCLES);
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('lets the payment method through on a non-updatable real invoice and keeps the rest locked', async () => {
    const data = {
      payment_method: { set: [{ id: 2 }] },
      bank_account: 20,
      updatable_admin: true,
      // anything else smuggled in is pinned back to the stored value
      code: 'HACKED',
      comments: 'changed',
    };
    await lifecycles.beforeUpdate({ params: { where: { id: 7 }, data } });

    expect(data.payment_method).toEqual({ set: [{ id: 2 }] });
    expect(data.bank_account).toBe(20);
    expect(data.code).toBe('F-0007');
    expect(data.comments).toBe('original');
    expect(data.state).toBeUndefined();
    expect(data.updatable_admin).toBe(false);
  });

  it('still refuses a plain update of a non-updatable invoice', async () => {
    await expect(
      lifecycles.beforeUpdate({ params: { where: { id: 7 }, data: { payment_method: 2 } } }),
    ).rejects.toThrow('emitted-invoice NOT updatable');
  });
});
