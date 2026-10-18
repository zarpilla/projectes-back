'use strict';

/**
 * issues/160 (2026-10-18): the old in-app previews of invoices and quotes
 * (front routes /invoice/:id/:type, /pdf/:id/:type and /quote/:id) are gone; the
 * PDF made by the API is the only way to see a document.
 *
 * - The pdf action printed the contact's current data instead of the client data
 *   saved with the document (`contact_info`): it read `contact_info` but never
 *   populated it. A quote whose client was renamed afterwards printed the new name.
 * - GET /quotes/:id filled an empty `pdf` with a link to the removed front route.
 */

const path = require('path');

const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'emitted-invoice', 'controllers', 'emitted-invoice.js');
const QUOTE_CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'quote', 'controllers', 'quote.js');

const quote = {
  id: 19,
  code: '2026-003',
  emitted: '2026-06-16',
  proforma: true,
  contact: { name: 'Nom actual', nif: 'B00000001', address: 'Carrer Nou, 2', postcode: '08001', city: 'Barcelona' },
  lines: [{ concept: 'Dinamització', quantity: 1, base: 100, discount: 0, vat: 21, irpf: 0 }],
  total_base: 100,
  total_vat: 21,
  total_irpf: 0,
  total: 121,
};
const saved = { name: 'Nom desat', nif: 'B00000000', address: 'Carrer Major, 1', postcode: '08000', city: 'Vilafranca' };

describe('pdf action prints the client saved with the document (issues/160)', () => {
  let customer;

  beforeEach(async () => {
    jest.resetModules();
    jest.doMock('../utils/microinvoice', () =>
      jest.fn().mockImplementation((options) => {
        customer = options.data.invoice.customer;
        return { options, generate: jest.fn() };
      }));
    jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ name: 'Coop' }) }));
    const ct = { uid: 'api::quote.quote', attributes: {} };
    global.strapi = {
      contentType: () => ct,
      contentTypes: { [ct.uid]: ct },
      db: {
        query: () => ({
          // like Strapi: a component is only there when it is populated
          findOne: async ({ populate }) => (populate.contact_info ? { ...quote, contact_info: saved } : quote),
          update: async () => ({}),
        }),
      },
    };
    const ctrl = require(CONTROLLER)({ strapi: global.strapi });
    await ctrl.pdf({ params: { id: 19, doc: 'quote' } });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('uses contact_info, not the contact as it is now', () => {
    expect(customer[0].value).toEqual(['Nom desat', 'B00000000', 'Carrer Major, 1', '08000 Vilafranca']);
  });
});

describe('GET /quotes/:id (issues/160)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (uid, build) => ({ strapi }) => {
          const ctrl = build({ strapi });
          Object.setPrototypeOf(ctrl, { findOne: async () => ({ data: { id: 19, pdf: null } }) });
          return ctrl;
        },
      },
    }));
    jest.doMock('../src/services/me-settings', () => ({ getFrontUrl: async () => 'https://app.test/' }), { virtual: true });
    global.strapi = {
      documents: () => ({ findFirst: async () => ({ front_url: 'https://app.test/' }) }),
    };
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('leaves an empty pdf empty: there is no front preview to link to', async () => {
    const ctrl = require(QUOTE_CONTROLLER)({ strapi: global.strapi });
    const response = await ctrl.findOne({ params: { id: '19' }, query: {} });
    expect(response.data.pdf).toBeNull();
  });
});

describe('clearQuotePreviewLinks startup script (issues/160)', () => {
  const rows = [
    { id: 1, pdf: 'https://app.test/quote/1' },
    { id: 2, pdf: 'https://app.test/#/quote/2' },
    { id: 3, pdf: 'https://app.test/quote/3/extra' },
  ];
  let calls;

  beforeEach(() => {
    jest.resetModules();
    calls = [];
    // a knex-like chain that records each call
    const chain = (table) => {
      const q = { table, steps: [] };
      calls.push(q);
      const step = (name) => (...args) => {
        q.steps.push([name, ...args]);
        return name === 'whereNot' ? Promise.resolve(rows) : builder;
      };
      const builder = { select: step('select'), where: step('where'), whereNot: step('whereNot'), whereIn: step('whereIn'), update: step('update') };
      return builder;
    };
    global.strapi = {
      db: { metadata: { get: () => ({ tableName: 'quotes' }) }, connection: chain },
      log: { info: jest.fn() },
    };
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('empties the pdf of the quotes linking to the front preview, and only those', async () => {
    const { clearQuotePreviewLinks } = require('../src/services/clear-quote-preview-links');
    expect(await clearQuotePreviewLinks()).toBe(2);
    expect(calls[0].steps).toEqual([
      ['select', 'id', 'pdf'],
      ['where', 'pdf', 'like', '%quote/%'],
      ['whereNot', 'pdf', 'like', '/uploads/%'],
    ]);
    expect(calls[1].steps).toEqual([['whereIn', 'id', [1, 2]], ['update', { pdf: null }]]);
  });
});
