'use strict';

/**
 * Guards the one-invoice-per-order unique index startup script.
 *
 * The 2026-09-30 incident could happened partly because orders_emitted_
 * invoice_lnk only carried the composite unique (order_id,
 * emitted_invoice_id): the same order could be linked to two DIFFERENT
 * invoices. The startup script adds the single-column unique that the
 * schema's oneToOne relation actually promises — without anyone running
 * DDL by hand against a tenant database.
 */

const path = require('path');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'ensure-order-invoice-unique-index.js');

// rawExecute() unwraps mysql2's [rows, fields] shape, so the raw mock always
// answers with rows + an (empty) fields array.
const mysqlResult = (rows) => [rows, []];

describe('ensureOrderInvoiceUniqueIndex', () => {
  let issued;
  let answers;

  const loadAndRun = () => require(SERVICE).ensureOrderInvoiceUniqueIndex();

  beforeEach(() => {
    jest.resetModules();
    issued = [];
    answers = {
      duplicates: [], // rows from the GROUP BY duplicates check
      existing: [], // rows from the information_schema index check
    };
    global.strapi = {
      log: { info: () => {}, warn: () => {}, error: () => {} },
      db: {
        connection: {
          raw: async (query, bindings) => {
            issued.push({ query, bindings });
            if (/GROUP BY order_id/.test(query)) return mysqlResult(answers.duplicates);
            if (/information_schema\.STATISTICS/.test(query)) return mysqlResult(answers.existing);
            return mysqlResult([{ affectedRows: 0 }]);
          },
        },
      },
    };
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('creates the single-column unique index when only the composite one exists', async () => {
    await loadAndRun();

    const create = issued.find((s) => /^CREATE UNIQUE INDEX/.test(s.query));
    expect(create).toBeDefined();
    expect(create.query).toContain('orders_emitted_invoice_order_uq');
    expect(create.query).toContain('(order_id)');
    expect(create.bindings).toEqual([]);
  });

  it('does nothing when a single-column unique index already exists', async () => {
    answers.existing = [{ name: 'orders_emitted_invoice_order_uq' }];

    await loadAndRun();

    expect(issued.some((s) => /^CREATE UNIQUE INDEX/.test(s.query))).toBe(false);
  });

  it('refuses to build the index while an order is linked to two invoices', async () => {
    answers.duplicates = [{ order_id: 5, c: 2 }];

    await expect(loadAndRun()).rejects.toThrow(/order 5 is linked to 2 emitted invoices/);
    expect(issued.some((s) => /^CREATE UNIQUE INDEX/.test(s.query))).toBe(false);
  });
});
