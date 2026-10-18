'use strict';

/**
 * Found while writing the manual (2026-10): «Peu de les comandes»
 * (me.order_footer, Configuració general) was not printed anywhere. v3 added it
 * to the order PDF in May 2024 (commit 015b16b, «orders pdf») and dropped it a
 * week later when that PDF became the box label (8a90c60). It is printed again
 * at the bottom of every page of the albarans, under the issuer line, without
 * adding pages when it is long.
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

describe('order.pdfmultiple: «Peu de les comandes»', () => {
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
      texts.push(String(value));
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

  it('prints the footer on every page of the albarans', async () => {
    const res = await ctrl.pdfmultiple({ request: { body: { orders: [1, 2] } }, send: () => {} });

    expect(texts.filter((t) => t === footer)).toHaveLength(3); // 2 + 1 boxes
    const { PDFDocument } = require('pdf-lib');
    const merged = await PDFDocument.load(fs.readFileSync(path.join(tmp, 'public', res.urls)));
    expect(merged.getPageCount()).toBe(3);
  });

  it('keeps one page per box with a long footer', async () => {
    footer = Array.from({ length: 40 }, (_, i) => `Línia ${i + 1} del peu de les comandes`).join('\n');
    const res = await ctrl.pdfmultiple({ request: { body: { orders: [1] } }, send: () => {} });

    const { PDFDocument } = require('pdf-lib');
    const merged = await PDFDocument.load(fs.readFileSync(path.join(tmp, 'public', res.urls)));
    expect(merged.getPageCount()).toBe(2);
  });

  it('prints nothing more without a footer', async () => {
    footer = null;
    await ctrl.pdfmultiple({ request: { body: { orders: [2] } }, send: () => {} });
    expect(texts).not.toContain('null');
    expect(texts).not.toContain('');
  });
});
