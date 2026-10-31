'use strict';

/**
 * issues/374 (security review 2026-10-31): /uploads is served without login,
 * and some generated PDFs had computable names. `uploads/orders/orders-1189.pdf`
 * gave anyone a delivery note (customer name, address, phone) by its order id;
 * invoice PDFs were named with an md5 of their type, code and id. And the
 * key-material guard tested the raw path while the static server decodes it:
 * `/uploads/<key>%2Ejson` served the Google service-account key.
 *
 * Guards: random names for delivery notes, names keyed with a server secret for
 * invoices and quotes, the existing files renamed once, and the decoded path
 * checked.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('pdf-names (issues/374)', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    jest.resetModules();
  });

  it('random tokens are 32 hex and differ', () => {
    const { randomToken } = require('../src/services/pdf-names');
    expect(randomToken()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomToken()).not.toBe(randomToken());
  });

  it('stable tokens depend on the secret, not only on the document', () => {
    process.env.APP_KEYS = 'a,b';
    delete process.env.PDF_NAME_SECRET;
    let { stableToken } = require('../src/services/pdf-names');
    const one = stableToken('Factura', '2026-001', 'api::emitted-invoice.emitted-invoice', 7);
    expect(one).toMatch(/^[0-9a-f]{32}$/);
    expect(stableToken('Factura', '2026-001', 'api::emitted-invoice.emitted-invoice', 7)).toBe(one);
    jest.resetModules();
    process.env.APP_KEYS = 'another';
    ({ stableToken } = require('../src/services/pdf-names'));
    expect(stableToken('Factura', '2026-001', 'api::emitted-invoice.emitted-invoice', 7)).not.toBe(one);
  });
});

describe('block-key-material (issues/374)', () => {
  const middleware = require('../src/middlewares/block-key-material')({}, { strapi: { log: { warn: jest.fn() } } });
  const run = async (p) => {
    const ctx = { path: p, ip: '1.2.3.4', notFound: jest.fn(() => 'nf') };
    const next = jest.fn();
    await middleware(ctx, next);
    return next.mock.calls.length ? 'served' : 'refused';
  };

  it.each([
    '/uploads/key_abc.json',
    '/uploads/key_abc%2Ejson',
    '/uploads/key_abc%2ejson',
    '/uploads/cert_abc%2Ep12',
    '/uploads/%E0%A4%A.pdf',
  ])('refuses %s', async (p) => {
    expect(await run(p)).toBe('refused');
  });

  it.each(['/uploads/factura_abc.pdf', '/uploads/logo%20nou.png', '/manifest.json'])('serves %s', async (p) => {
    expect(await run(p)).toBe('served');
  });
});

describe('renameGuessablePdfs (issues/374)', () => {
  let dir;
  beforeEach(() => {
    jest.resetModules();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfs-'));
    fs.mkdirSync(path.join(dir, 'uploads', 'orders'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'uploads', 'documents'), { recursive: true });
    for (const n of ['orders-1189.pdf', '1189-H66021acf64a52b3a.pdf']) {
      fs.writeFileSync(path.join(dir, 'uploads', 'orders', n), 'x');
    }
    for (const n of [
      'Factura-Coop-2026-001-H0123456789abcdef.pdf',
      'Altres-Coop-2026-002-ESBORRANY-Hfedcba9876543210.pdf',
      'Factura-Coop-2026-003-H0123456789abcdef0123456789abcdef.pdf',
      'notes.txt',
    ]) {
      fs.writeFileSync(path.join(dir, 'uploads', 'documents', n), 'x');
    }
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('removes the delivery notes and renames the old-hash documents, updating their rows', async () => {
    const updates = [];
    global.strapi = {
      dirs: { static: { public: dir } },
      log: { info: jest.fn() },
      db: {
        metadata: { get: (uid) => ({ tableName: uid.includes('quote') ? 'quotes' : 'emitted_invoices' }) },
        connection: (table) => ({
          where: (col, value) => ({
            update: async (data) => {
              updates.push({ table, col, value, data });
              return value.includes('2026-001') && table === 'emitted_invoices' ? 1 : 0;
            },
          }),
        }),
      },
    };
    const { renameGuessablePdfs } = require('../src/services/rename-guessable-pdfs');
    const result = await renameGuessablePdfs();

    expect(fs.readdirSync(path.join(dir, 'uploads', 'orders'))).toEqual([]);
    const docs = fs.readdirSync(path.join(dir, 'uploads', 'documents')).sort();
    expect(docs).toContain('notes.txt');
    expect(docs).toContain('Factura-Coop-2026-003-H0123456789abcdef0123456789abcdef.pdf');
    expect(docs.filter((n) => /-H[0-9a-f]{16}\.pdf$/.test(n))).toEqual([]);
    expect(docs.some((n) => /^Altres-Coop-2026-002-ESBORRANY-H[0-9a-f]{32}\.pdf$/.test(n))).toBe(true);
    expect(result).toEqual({ removed: 2, renamed: 2, rows: 1 });

    const invoice = updates.find((u) => u.table === 'emitted_invoices' && u.value.includes('2026-001'));
    expect(invoice.value).toBe('/uploads/documents/Factura-Coop-2026-001-H0123456789abcdef.pdf');
    expect(invoice.data.pdf).toMatch(/^\/uploads\/documents\/Factura-Coop-2026-001-H[0-9a-f]{32}\.pdf$/);
    expect(fs.existsSync(path.join(dir, invoice.data.pdf))).toBe(true);

    // a second run finds nothing to do
    expect(await renameGuessablePdfs()).toEqual({ removed: 0, renamed: 0, rows: 0 });
  });
});
