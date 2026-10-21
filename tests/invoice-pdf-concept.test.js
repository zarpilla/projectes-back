'use strict';

/**
 * issues/312 (2026-10-21): La Diligència wants every invoice made by «Facturar»
 * (orders) to print a concept naming the billed service, e.g.
 * «Serveis de Transport i Logística_Octubre_2026». The text is theirs, so it is a
 * setting (me.orders_options.invoice_concept); the month is the orders' month.
 * It goes in a new client-facing field (`concept`), printed on the PDF:
 * `document_concept` stays the internal concept («Concepte intern»).
 */

const path = require('path');

const { invoicePdfConcept } = require('../src/api/order/services/invoice-line-concept');

describe('invoicePdfConcept (issues/312)', () => {
  const TEXT = 'Serveis de Transport i Logística';

  it('joins the text, the orders\' month and year with underscores', () => {
    expect(
      invoicePdfConcept([{ estimated_delivery_date: '2026-10-03' }, { estimated_delivery_date: '2026-10-28' }], TEXT),
    ).toBe('Serveis de Transport i Logística_Octubre_2026');
  });

  it('uses the estimated delivery month, not the route date', () => {
    expect(invoicePdfConcept([{ route_date: '2026-09-30', estimated_delivery_date: '2026-10-01' }], TEXT)).toBe(
      'Serveis de Transport i Logística_Octubre_2026',
    );
  });

  it('names both months when the orders span several', () => {
    expect(
      invoicePdfConcept([{ estimated_delivery_date: '2026-10-02' }, { estimated_delivery_date: '2026-09-29' }], TEXT),
    ).toBe('Serveis de Transport i Logística_Setembre_Octubre_2026');
    expect(
      invoicePdfConcept([{ estimated_delivery_date: '2026-12-30' }, { estimated_delivery_date: '2027-01-02' }], TEXT),
    ).toBe('Serveis de Transport i Logística_Desembre_2026_Gener_2027');
  });

  it('is null without a text', () => {
    expect(invoicePdfConcept([{ estimated_delivery_date: '2026-10-03' }], '')).toBeNull();
    expect(invoicePdfConcept([{ estimated_delivery_date: '2026-10-03' }], '  ')).toBeNull();
    expect(invoicePdfConcept([{ estimated_delivery_date: '2026-10-03' }], undefined)).toBeNull();
  });
});

describe('«Facturar» fills the PDF concept from the settings (issues/312)', () => {
  const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'order', 'controllers', 'order.js');
  let created;

  const run = async (ordersOptions) => {
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    created = [];
    const ct = { uid: 'api::order.order', modelName: 'order', apiName: 'order', kind: 'collectionType', attributes: {} };
    const orders = [1, 2].map((id) => ({
      id,
      status: 'delivered',
      owner: { id: 7 },
      route: { name: 'R1' },
      route_date: '2026-09-30',
      estimated_delivery_date: `2026-10-0${id}`,
      price: 10,
    }));
    global.strapi = {
      contentType: () => ct,
      contentTypes: { 'api::order.order': ct },
      log: { warn: () => {}, info: () => {} },
      documents: (uid) => ({
        findFirst: async () => (uid === 'api::me.me' ? { name: 'Coop', orders_options: ordersOptions } : null),
      }),
      service: () => ({
        create: async ({ data }) => {
          const invoice = { id: 100, code: 'ESBORRANY', total_base: 20, ...data };
          created.push(invoice);
          return invoice;
        },
      }),
      db: {
        query: (uid) => ({
          findMany: async () => {
            if (uid === 'api::serie.serie') return [{ id: 16, name: new Date().getFullYear() }];
            if (uid === 'api::payment-method.payment-method') return [{ id: 3 }];
            if (uid === 'api::contact.contact') return [{ id: 9, name: 'Acme', users_permissions_user: { id: 7 } }];
            if (uid === 'api::order.order') return orders;
            return [];
          },
          findOne: async () => ({ id: 30, name: 'P', project_phases: [{ id: 2, incomes: [] }] }),
          create: async ({ data }) => data,
          update: async (args) => args.data,
        }),
        connection: Object.assign(() => ({ where: () => ({ update: async () => 1 }) }), {
          raw: async (q, bindings) => ({ affectedRows: (bindings || []).length }),
        }),
      },
    };
    const ctrl = require(CONTROLLER)({ strapi: global.strapi });
    await ctrl.invoice({ request: { body: { orders: [1, 2], project: 30 } }, send: () => {} });
  };

  afterEach(() => {
    delete global.strapi;
    jest.restoreAllMocks();
  });

  it('writes the configured text and the orders\' month', async () => {
    await run({ invoice_concept: 'Serveis de Transport i Logística' });
    expect(created).toHaveLength(1);
    expect(created[0].concept).toBe('Serveis de Transport i Logística_Octubre_2026');
    // the internal concept is unchanged
    expect(created[0].document_concept).toBe('Serveis logístics octubre 2026');
  });

  it('leaves it empty when no text is configured', async () => {
    await run({ next_day_limit_hour: 14 });
    expect(created[0].concept).toBeNull();
  });
});

describe('the PDF prints the invoice concept (issues/312)', () => {
  const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'emitted-invoice', 'controllers', 'emitted-invoice.js');
  let options;

  const pdf = async (doc, record) => {
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
      db: { query: () => ({ findOne: async () => record, update: async () => ({}) }) },
    };
    const ctrl = require(CONTROLLER)({ strapi: global.strapi });
    await ctrl.pdf({ params: { id: record.id, doc } });
  };

  const invoice = {
    id: 5,
    code: '2026-210',
    emitted: '2026-10-31',
    concept: 'Serveis de Transport i Logística_Octubre_2026',
    document_concept: 'intern',
    lines: [{ concept: 'Comanda 01/10/2026 | 0001 | R1', quantity: 1, base: 10, vat: 21 }],
    total_base: 10,
    total_vat: 2.1,
    total_irpf: 0,
    total: 12.1,
  };

  afterEach(() => {
    delete global.strapi;
  });

  it('passes the concept, never the internal one', async () => {
    await pdf('emitted-invoice', invoice);
    expect(options.data.invoice.details.concept).toBe('Serveis de Transport i Logística_Octubre_2026');
    expect(JSON.stringify(options)).not.toContain('intern');
  });

  it('prints no concept when the invoice has none', async () => {
    await pdf('emitted-invoice', { ...invoice, concept: null });
    expect(options.data.invoice.details.concept).toBeNull();
  });

  it('draws it above the lines', async () => {
    jest.resetModules();
    const MicroInvoice = jest.requireActual('../utils/microinvoice');
    const texts = [];
    const doc = new MicroInvoice({
      data: { invoice: { name: 'Factura', header: [], customer: [], seller: [], legal: [], details: {
        concept: invoice.concept,
        header: [{ value: 'Concepte' }],
        parts: [],
        total: [],
      } } },
    });
    doc.storage.customer = { height: 0 };
    doc.storage.seller = { height: 0 };
    doc.setText = (t) => texts.push(t);
    doc.generateTableRow = (type) => texts.push(`<${type}>`);
    doc.document = { page: { width: 595, height: 842 }, y: 0, addPage: () => {} };
    doc.generateParts();
    expect(texts.indexOf('Concepte: Serveis de Transport i Logística_Octubre_2026')).toBeGreaterThanOrEqual(0);
    expect(texts.indexOf('Concepte: Serveis de Transport i Logística_Octubre_2026')).toBeLessThan(texts.indexOf('<header>'));
  });
});
