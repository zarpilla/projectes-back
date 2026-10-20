'use strict';

/**
 * issues/213 (2026-10-19): the PDF of a rectificative (AB 2026-9, a line with
 * quantity -3) lost its Q. and Base columns, because they were only shown for
 * quantities above 1, and it was titled «Factura»: a rectificative must say so
 * (RD 1619/2012, art. 15; VeriFactu already sends it as R1).
 *
 * Calls the pdf action with the PDF writer mocked and checks what it would print.
 */

const path = require('path');

const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'emitted-invoice', 'controllers', 'emitted-invoice.js');

const base = {
  id: 900,
  code: 'AB 2026-9',
  emitted: '2026-10-01',
  contact: { name: 'Client' },
  lines: [{ concept: 'Hores', quantity: -3, base: 40, discount: 0, vat: 21, irpf: 0 }],
  total_base: -120,
  total_vat: -25.2,
  total_irpf: 0,
  total: -145.2,
};

async function render(invoice, doc = 'emitted-invoice') {
  let options;
  let populate;
  jest.resetModules();
  jest.doMock('../utils/microinvoice', () =>
    jest.fn().mockImplementation((opts) => {
      options = opts;
      return { options: opts, generate: jest.fn() };
    }));
  jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ name: 'Coop' }) }));
  const ct = { uid: 'api::emitted-invoice.emitted-invoice', attributes: {} };
  global.strapi = {
    contentType: () => ct,
    contentTypes: { [ct.uid]: ct },
    db: {
      query: () => ({
        findOne: async (q) => {
          populate = q.populate;
          return invoice;
        },
        update: async () => ({}),
      }),
    },
  };
  const ctrl = require(CONTROLLER)({ strapi: global.strapi });
  await ctrl.pdf({ params: { id: invoice.id, doc } });
  return { invoice: options.data.invoice, populate };
}

afterEach(() => {
  delete global.strapi;
});

describe('pdf of a rectificative (issues/213)', () => {
  it('shows the quantity and unit price of a negative line', async () => {
    const { invoice } = await render(base);
    const header = invoice.details.header.map((h) => h.value);
    expect(header).toEqual(expect.arrayContaining(['Q.', 'Base']));
    const row = invoice.details.parts[0];
    expect(row[header.indexOf('Q.')].value).toBe('-3');
    expect(row[header.indexOf('Base')].value).toBe(40);
  });

  it('still hides them when every quantity is 1', async () => {
    const { invoice } = await render({ ...base, lines: [{ ...base.lines[0], quantity: 1 }] });
    expect(invoice.details.header.map((h) => h.value)).not.toContain('Q.');
  });

  it('is titled «Factura rectificativa» on a rectificative serie or with a rectified invoice', async () => {
    const bySerial = await render({ ...base, serial: { id: 3, rectificative: true } });
    expect(bySerial.populate).toMatchObject({ serial: true, rectified_invoice: true });
    expect(bySerial.invoice.name).toBe('Factura rectificativa');
    const byLink = await render({ ...base, rectified_invoice: { id: 800 }, document_type: { name: 'Factura' } });
    expect(byLink.invoice.name).toBe('Factura rectificativa');
  });

  it('keeps «Factura» for an ordinary invoice and the quote titles', async () => {
    expect((await render({ ...base, serial: { id: 1, rectificative: false } })).invoice.name).toBe('Factura');
    const quote = await render({ ...base, rectified_invoice: { id: 800 } }, 'quote');
    expect(quote.invoice.name).toBe('Pressupost');
    expect(quote.populate.serial).toBeUndefined();
  });
});
