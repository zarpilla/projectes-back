'use strict';

/**
 * issues/299 (2026-10-20, review 9): on an invoice with discounts the PDF's
 * line column headed «Base imposable» printed quantity x price before the
 * discount (37,04 EUR on a line whose base is 33,33 EUR), so the column added up
 * to more than the «Base imposable» total. With a discount column it is now
 * headed «Import brut» and adds up to «Base sense descompte»; without one the
 * amount is the taxable base and keeps its label.
 */

const path = require('path');

const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'emitted-invoice', 'controllers', 'emitted-invoice.js');

const withDiscount = {
  id: 35,
  code: '2026-035',
  emitted: '2026-05-01',
  contact: { name: 'Client' },
  lines: [
    { concept: 'Taller', quantity: 1, base: 37.04, discount: 10, vat: 0, irpf: 0 },
    { concept: 'Material', quantity: 2, base: 10, discount: 0, vat: 0, irpf: 0 },
  ],
  total_base: 53.34,
  total_vat: 0,
  total_irpf: 0,
  total: 53.34,
};

const withoutDiscount = {
  ...withDiscount,
  lines: [{ concept: 'Material', quantity: 2, base: 10, discount: 0, vat: 0, irpf: 0 }],
  total_base: 20,
  total: 20,
};

const render = async (invoice) => {
  let data;
  jest.resetModules();
  jest.doMock('../utils/microinvoice', () =>
    jest.fn().mockImplementation((options) => {
      data = options.data.invoice;
      return { options, generate: jest.fn() };
    }));
  jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ name: 'Coop' }) }));
  const ct = { uid: 'api::emitted-invoice.emitted-invoice', attributes: {} };
  global.strapi = {
    contentType: () => ct,
    contentTypes: { [ct.uid]: ct },
    db: { query: () => ({ findOne: async () => invoice, update: async () => ({}) }) },
  };
  const ctrl = require(CONTROLLER)({ strapi: global.strapi });
  await ctrl.pdf({ params: { id: invoice.id, doc: 'emitted-invoice' } });
  return data;
};

const column = (details, label) => {
  const i = details.header.findIndex((h) => h.value === label);
  return i < 0 ? null : details.parts.map((p) => p[i].value);
};

const totalOf = (data, label) => data.details.total.find((t) => t.label === label)?.value;

describe('pdf line amount column (issues/299)', () => {
  afterEach(() => {
    delete global.strapi;
  });

  it('is «Import brut» and adds up to «Base sense descompte» when lines have a discount', async () => {
    const data = await render(withDiscount);
    expect(column(data.details, 'Base imposable')).toBeNull();
    const gross = column(data.details, 'Import brut');
    expect(gross).toEqual([37.04, 20]);
    expect(gross.reduce((s, v) => s + v, 0)).toBe(totalOf(data, 'Base sense descompte'));
  });

  it('keeps «Base imposable» when no line has a discount', async () => {
    const data = await render(withoutDiscount);
    expect(column(data.details, 'Import brut')).toBeNull();
    expect(column(data.details, 'Base imposable')).toEqual([20]);
    expect(totalOf(data, 'Base imposable')).toBe(20);
  });
});
