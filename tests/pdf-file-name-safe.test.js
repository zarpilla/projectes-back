'use strict';

/**
 * issues/414 (2026-11-06, Miceli): «Dieta» expense 303 — the PDF button opened
 * a tab that answered `{"data":null,"error":{"status":404,"name":"NotFoundError",…}}`.
 *
 * GET /api/emitted-invoices/pdf/:doc/:id names the file
 * `<type>-<contact name>-<code>-H<token>.pdf` and returns it as the URL the
 * front opens. The contact name went in as it was:
 *
 *   - `#` or `?` cut the URL the browser requested, and a stray `%` doesn't
 *     decode (block-key-material refuses it): the file was on disk, the tab 404.
 *   - `/` (or `\`) pointed into a folder that doesn't exist: the write failed,
 *     but microinvoice resolved on the document's 'end', so the URL of a file
 *     never written went out — and the write stream's unhandled 'error' killed
 *     the API process (reproduced on a local copy of the tenant).
 *
 * Guards: every piece of the name is safe for a path and a URL, names that were
 * already safe don't change, and generate() rejects when the file can't be written.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'emitted-invoice', 'controllers', 'emitted-invoice.js');

const expense = (contactName, code = '2026-033') => ({
  id: 303,
  code,
  emitted: '2026-11-05',
  document_type: { name: 'Dieta' },
  contact: { name: contactName, nif: '00000000T' },
  lines: [{ concept: 'Desplaçament - sense IRPF', quantity: 40, base: 0.26, discount: 0, vat: 0, irpf: 0 }],
  total_base: 10.4,
  total_vat: 0,
  total_irpf: 0,
  total: 10.4,
});

describe('pdf action: the file name is safe for a path and a URL (issues/414)', () => {
  let written;
  let stored;

  const pdfFor = async (doc) => {
    jest.resetModules();
    written = null;
    stored = null;
    jest.doMock('../utils/microinvoice', () =>
      jest.fn().mockImplementation((options) => ({
        options,
        generate: jest.fn(async (file) => {
          written = file;
        }),
      })));
    jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ name: 'Coop' }) }));
    const ct = { uid: 'api::received-expense.received-expense', attributes: {} };
    global.strapi = {
      contentType: () => ct,
      contentTypes: { [ct.uid]: ct },
      db: {
        query: () => ({
          findOne: async () => doc,
          update: async ({ data }) => {
            stored = data.pdf;
          },
        }),
      },
    };
    const ctrl = require(CONTROLLER)({ strapi: global.strapi });
    return ctrl.pdf({ params: { id: 303, doc: 'received-expense' } });
  };

  afterEach(() => {
    delete global.strapi;
  });

  // What the browser requests for window.open(apiUrl + url), and what the
  // static server then reads from disk.
  const servedPath = (url) => decodeURIComponent(new URL(url, 'https://api.test').pathname);

  it.each([
    ['#', 'Aina Carbonell #2'],
    ['?', 'Aina Carbonell? Bret'],
    ['%', 'Aina 50% Bret'],
    ['/', 'Aina Carbonell / Bret'],
    ['\\', 'Aina Carbonell \\ Bret'],
    ['a newline', 'Aina Carbonell\nBret'],
  ])('a contact name with %s opens the file that was written', async (_, name) => {
    const { url } = await pdfFor(expense(name));
    expect(written).toBe(`./public${url}`);
    expect(stored).toBe(url);
    expect(servedPath(url)).toBe(url);
    expect(path.posix.dirname(url)).toBe('/uploads/documents');
  });

  it('cleans the code too', async () => {
    const { url } = await pdfFor(expense('Esther Roca', 'D/2026#1'));
    expect(servedPath(url)).toBe(url);
    expect(path.posix.dirname(url)).toBe('/uploads/documents');
  });

  it('keeps the name of a PDF that was already safe', async () => {
    const { url } = await pdfFor(expense("Marta Sala Rifà, Cal Pep d'Amunt "));
    expect(url).toMatch(/^\/uploads\/documents\/Dieta-Marta Sala Rifà, Cal Pep d'Amunt -2026-033-H[0-9a-f]{32}\.pdf$/);
  });
});

describe('fileNamePart (issues/414)', () => {
  const { fileNamePart } = require('../src/services/pdf-names');

  it('replaces path and URL characters, keeps the rest', () => {
    expect(fileNamePart('A/B\\C#D?E%F')).toBe('A-B-C-D-E-F');
    expect(fileNamePart("Núria L'Hospitalet SCCL")).toBe("Núria L'Hospitalet SCCL");
    expect(fileNamePart(undefined)).toBe('undefined');
  });
});

describe('microinvoice generate (issues/414)', () => {
  // the options the pdf action really builds for a «Dieta» expense
  let options;
  beforeAll(async () => {
    jest.resetModules();
    jest.doMock('../utils/microinvoice', () =>
      jest.fn().mockImplementation((opts) => ({ options: (options = opts), generate: async () => {} })));
    jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ name: 'Coop' }) }));
    const ct = { uid: 'api::received-expense.received-expense', attributes: {} };
    global.strapi = {
      contentType: () => ct,
      contentTypes: { [ct.uid]: ct },
      db: { query: () => ({ findOne: async () => expense('Aina'), update: async () => ({}) }) },
    };
    await require(CONTROLLER)({ strapi: global.strapi }).pdf({ params: { id: 303, doc: 'received-expense' } });
    delete global.strapi;
    jest.dontMock('../utils/microinvoice');
    jest.resetModules();
  });

  const invoice = () => new (require('../utils/microinvoice'))(options);
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf414-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects when the file cannot be written, instead of resolving', async () => {
    await expect(invoice().generate(path.join(dir, 'missing', 'x.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resolves once the whole file is on disk', async () => {
    const file = path.join(dir, 'x.pdf');
    await invoice().generate(file);
    expect(fs.readFileSync(file, 'latin1').trimEnd()).toMatch(/%%EOF$/);
  });
});
