'use strict';

/**
 * Regression: issues/036 (2026-10-12) — la diligencia could not print the
 * orders PDF.
 *
 * POST /api/orders/pdf merged the per-order PDFs with `pdf-merge`, which
 * shells out to the `pdftk` binary. The backends moved to Docker on
 * 2026-10-09 and the image (node:20-bookworm-slim) has no pdftk, so every
 * request failed with a 500.
 *
 * Guards:
 *   - pdfmultiple() builds the merged PDF without spawning any process;
 *   - the merged file holds one page per box of every order;
 *   - the order is read with the box lines and the transfer pickups, which the
 *     v5 Document/Query layer does not return without an explicit populate.
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

describe('order.pdfmultiple without pdftk', () => {
  const cwd = process.cwd();
  let tmp;
  let ctrl;
  let spawned;
  let orderQuery;

  beforeEach(async () => {
    jest.resetModules();
    spawned = [];
    orderQuery = null;

    // No pdftk (nor anything else) on this machine.
    jest.doMock('child_process', () => {
      const fail = (name) => (...args) => {
        spawned.push([name, args[0]]);
        const cb = args[args.length - 1];
        const err = new Error('/bin/sh: 1: pdftk: not found');
        if (typeof cb === 'function') return cb(err);
        throw err;
      };
      return {
        ...jest.requireActual('child_process'),
        exec: fail('exec'),
        execFile: fail('execFile'),
        spawn: fail('spawn'),
      };
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
            ? { name: 'La Diligència', logo: { url: '/uploads/logo.png', width: 20, height: 10 } }
            : { front_url: 'https://example.org/' },
      }),
      db: {
        query: (uid) => ({
          findMany: async (args = {}) => {
            if (uid === 'api::contact.contact') return [{ id: 9, name: 'Productora SCCL' }];
            if (uid === 'api::order.order') {
              orderQuery = args;
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
    jest.dontMock('child_process');
    jest.restoreAllMocks();
  });

  it('merges the order PDFs in-process, one page per box', async () => {
    const sent = [];
    const ctx = { request: { body: { orders: [1, 2] } }, send: (payload, status) => sent.push({ payload, status }) };

    const res = await ctrl.pdfmultiple(ctx);

    expect(sent).toEqual([]);
    expect(spawned).toEqual([]);
    expect(res.urls).toMatch(/^\/uploads\/orders\/orders-[0-9a-f]+\.pdf$/);

    const { PDFDocument } = require('pdf-lib');
    const merged = await PDFDocument.load(fs.readFileSync(path.join(tmp, 'public', res.urls)));
    expect(merged.getPageCount()).toBe(3); // order 1: 2 boxes, order 2: 1 box
  });

  it('reads the box lines and the transfer pickups of each order', async () => {
    await ctrl.pdfmultiple({ request: { body: { orders: [2] } }, send: () => {} });

    expect(orderQuery.populate).toMatchObject({
      lines: true,
      transfer_pickup_origin: true,
      transfer_pickup_destination: true,
    });
  });
});
