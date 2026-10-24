'use strict';

/**
 * issues/340 (2026-10-24): settling VAT («Salda» in «IVA», POST
 * /emitted-invoices/pay-vat-ids).
 * - The body sends the ids of four kinds of document; a missing list answered
 *   a 500 (`undefined.includes`). A missing list is an empty one.
 * - POST /emitted-invoices/pay-vat settled every unsettled document of every
 *   year at once, open to every role with the issued-invoice permissions and
 *   called by no screen: it is gone.
 * issues/339: a draft issued invoice can't be settled: its VAT isn't due yet.
 */

const path = require('path');

const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'emitted-invoice', 'controllers', 'emitted-invoice.js');
const ROUTES = path.join(__dirname, '..', 'src', 'api', 'emitted-invoice', 'routes', '01-custom-emitted-invoice.js');
const UID = 'api::emitted-invoice.emitted-invoice';

const mockRawExecute = jest.fn(async () => {});
jest.mock('../src/services/raw-sql', () => ({ rawExecute: (...args) => mockRawExecute(...args) }));
jest.mock('../src/services/me-settings', () => ({
  getMe: async () => ({ bank_account_vat: { id: 3 }, options: { deductible_vat_pct: 80 } }),
}));
jest.mock('../src/services/change-log', () => ({
  isTracked: () => false,
  rowWith: async () => null,
  logRawUpdate: async () => {},
}));

const DOCS = {
  [UID]: [
    { id: 1, emitted: '2026-02-10', total_vat: 21, state: 'real' },
    { id: 2, emitted: '2026-02-11', total_vat: 50, state: 'draft' },
  ],
  'api::received-invoice.received-invoice': [{ id: 7, emitted: '2026-02-12', total_vat: 10 }],
};

function mockStrapi() {
  const create = jest.fn(async () => ({}));
  const ct = { uid: UID, kind: 'collectionType', attributes: {}, options: {} };
  global.strapi = {
    contentType: () => ct,
    contentTypes: { [UID]: ct },
    db: {
      query: jest.fn((uid) => ({
        findMany: jest.fn(async () => (uid === 'api::year.year' ? [{ year: 2026, deductible_vat_pct: 50 }] : DOCS[uid] || [])),
      })),
    },
    service: jest.fn(() => ({ create })),
  };
  return { create };
}

const ctxWith = (body) => ({ request: { body }, state: { user: { id: 5 } } });

describe('pay-vat-ids (issues/340, issues/339)', () => {
  let ctrl;
  beforeEach(() => {
    jest.resetModules();
    mockRawExecute.mockClear();
  });
  afterEach(() => {
    delete global.strapi;
  });

  it('takes a missing list as empty', async () => {
    const { create } = mockStrapi();
    ctrl = require(CONTROLLER)({ strapi: global.strapi });
    await expect(ctrl.payVatIds(ctxWith({ receivedInvoices: [7], vat_paid_date: '2026-04-15' }))).resolves.toMatchObject({ done: true });
    // 10 € of supported VAT at the year's 50 %
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ comment: 'IVA Saldat', total: 5, date: '2026-04-15' }) });
  });

  it('never settles a draft issued invoice', async () => {
    const { create } = mockStrapi();
    ctrl = require(CONTROLLER)({ strapi: global.strapi });
    await ctrl.payVatIds(ctxWith({ emittedInvoices: [1, 2], vat_paid_date: '2026-04-15' }));
    expect(mockRawExecute.mock.calls.map((c) => c[2][2])).toEqual([1]);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ total: -21 }) });
  });

  it('has no settle-everything endpoint', () => {
    mockStrapi();
    ctrl = require(CONTROLLER)({ strapi: global.strapi });
    const routes = require(ROUTES);
    expect(ctrl.payVat).toBeUndefined();
    expect((routes.routes || routes).map((r) => r.path)).not.toContain('/emitted-invoices/pay-vat');
  });
});
