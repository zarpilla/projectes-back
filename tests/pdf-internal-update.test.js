'use strict';

/**
 * Guards the `_internal` flag on the PDF path write.
 *
 * `GET /api/emitted-invoices/pdf/quote/:id` answered 500 for every quote:
 * "Undefined binding(s) detected when compiling WHERE. Undefined column(s):
 * [t0.id]".
 *
 * After rendering, the controller writes the file path back with
 * `strapi.db.query(uid).update({ data: { pdf } })`. In v3 that write carried
 * `_internal: true`, the flag every model checks to tell an internal write from
 * a user edit. The v5 port dropped it, assuming `strapi.db.query()` bypassed
 * lifecycles — it does not. So a payload containing only `pdf` reached quote's
 * beforeUpdate as if it were a real edit, which then:
 *
 *   - recomputed the totals from an absent `lines`, zeroing them, and
 *   - re-derived `code` from an absent `serial`, sending `where: { id: undefined }`
 *     to knex, which throws instead of answering null the way v3's query layer did.
 */

const fs = require('fs');
const path = require('path');

const CONTROLLER = path.join(
  __dirname, '..', 'src', 'api', 'emitted-invoice', 'controllers', 'emitted-invoice.js',
);

describe('pdf controller', () => {
  const source = fs.readFileSync(CONTROLLER, 'utf8');

  it('marks the pdf-path write as internal', () => {
    const write = source.slice(source.indexOf('await strapi.db.query(docUid).update('));
    expect(write.slice(0, 200)).toContain('_internal: true');
  });
});

describe('quote lifecycles', () => {
  const LIFECYCLES = path.join(
    __dirname, '..', 'src', 'api', 'quote', 'content-types', 'quote', 'lifecycles.js',
  );

  let queries;
  let lifecycles;

  beforeEach(() => {
    queries = [];
    const rows = {
      'api::serie.serie': { id: 3, name: 'PRESS', leadingZeros: 4 },
      'api::contact.contact': { id: 9, name: 'Acme', nif: 'B123' },
    };
    global.strapi = {
      db: {
        query: (uid) => ({
          findOne: async (args) => {
            queries.push({ uid, where: args.where });
            return rows[uid] || null;
          },
          findMany: async (args) => {
            queries.push({ uid, where: args.where });
            return [];
          },
        }),
      },
    };
    jest.resetModules();
    lifecycles = require(LIFECYCLES);
  });

  afterEach(() => {
    delete global.strapi;
  });

  const update = async (data) => {
    await lifecycles.beforeUpdate({ params: { data } });
    return data;
  };

  it('leaves an internal pdf-path write untouched', async () => {
    const data = await update({ pdf: '/uploads/documents/x.pdf', _internal: true });
    expect(data).toEqual({ pdf: '/uploads/documents/x.pdf', _internal: true });
    expect(queries).toEqual([]);
  });

  it('never queries a serie with an undefined id', async () => {
    // The v5 db layer hands `{ id: undefined }` straight to knex, which throws.
    await update({ pdf: '/uploads/documents/x.pdf' });
    const undefinedLookups = queries.filter((q) => q.where && q.where.id === undefined);
    expect(undefinedLookups).toEqual([]);
  });

  it('still numbers a quote that carries its serial', async () => {
    const data = await update({ serial: 3, lines: [{ base: 100, quantity: 2, vat: 21 }] });
    expect(data.code).toBe('PRESS-0001');
    expect(data.total_base).toBe(200);
    expect(data.total_vat).toBe(42);
    expect(data.total).toBe(242);
    expect(data.total_irpf).toBe(0);
  });

  it('denormalizes contact_info from the linked contact', async () => {
    const data = await update({ contact: 9, _internal: true });
    expect(data.contact_info).toMatchObject({ name: 'Acme', nif: 'B123' });
  });
});
