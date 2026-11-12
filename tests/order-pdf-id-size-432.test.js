'use strict';

/**
 * issues/432: on the albarà the order number (COMANDA) was printed at the
 * regular 12 pt, much smaller than the delivery date (20 pt) above the client.
 * The Diligència wants the id as big as the date.
 */



const fs = require('fs');
const os = require('os');
const path = require('path');

const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'order', 'controllers', 'order.js');

const order = (id, extra = {}) => ({
  id,
  createdAt: '2026-10-01T08:00:00.000Z',
  units: 1,
  kilograms: 5,
  estimated_delivery_date: '2026-10-13',
  owner: { id: 7, username: 'productora' },
  contact: { trade_name: 'Botiga', address: 'Carrer Major 1', postcode: '08001', city: 'Barcelona' },
  route: { name: 'R1' },
  pickup: { name: 'Magatzem' },
  ...extra,
});

describe('order.pdfmultiple: order id size (issues/432): «Peu de les comandes»', () => {
  const cwd = process.cwd();
  let tmp;
  let ctrl;
  let footer;
  let texts;

  beforeEach(async () => {
    jest.resetModules();

    footer = 'Gràcies per comptar amb nosaltres · IBAN ES00 0000 0000 0000 0000 0000';
    texts = [];
    const PDFKit = require('pdfkit');
    const text = PDFKit.prototype.text;
    jest.spyOn(PDFKit.prototype, 'text').mockImplementation(function (value, ...rest) {
      texts.push({ value: String(value), size: this._fontSize });
      return text.call(this, value, ...rest);
    });

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'order-pdf-'));
    fs.mkdirSync(path.join(tmp, 'public', 'uploads'), { recursive: true });
    await require('sharp')({
      create: { width: 20, height: 10, channels: 3, background: '#336699' },
    })
      .png()
      .toFile(path.join(tmp, 'public', 'uploads', 'logo.png'));
    process.chdir(tmp);

    const ct = { uid: 'api::order.order', modelName: 'order', apiName: 'order', kind: 'collectionType', attributes: {} };
    const orders = [order(1, { units: 2 }), order(2)];

    global.strapi = {
      contentType: () => ct,
      contentTypes: { 'api::order.order': ct },
      log: { warn: () => {}, info: () => {} },
      documents: (uid) => ({
        findFirst: async () =>
          uid === 'api::me.me'
            ? { name: 'La Diligència', order_footer: footer, logo: { url: '/uploads/logo.png', width: 20, height: 10 } }
            : { front_url: 'https://example.org/' },
      }),
      db: {
        query: (uid) => ({
          findMany: async (args = {}) => {
            if (uid === 'api::contact.contact') return [{ id: 9, name: 'Productora SCCL' }];
            if (uid === 'api::order.order') {
              return orders.filter((o) => args.where.id.$in.includes(o.id));
            }
            return [];
          },
        }),
      },
    };

    ctrl = require(CONTROLLER)({ strapi: global.strapi });
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
    delete global.strapi;
    jest.restoreAllMocks();
  });

  it('prints the order id at the same size as the delivery date', async () => {
    await ctrl.pdfmultiple({ request: { body: { orders: [2] } }, send: () => {} });

    const id = texts.find((t) => t.value === '0002');
    const date = texts.find((t) => t.value === '2026-10-13');
    expect(id).toBeDefined();
    expect(date).toBeDefined();
    expect(id.size).toBe(date.size);
  });
});
