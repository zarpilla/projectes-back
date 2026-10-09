'use strict';

/**
 * Regression: issues/023 — an update that sent new lines to an issued (real)
 * emitted invoice deleted its stored line.
 *
 * emitted-invoice beforeUpdate pins `data.lines = invoice.lines`, but in
 * Strapi 5 the document service replaces the components before the db
 * lifecycle runs: the old line row was deleted, the new one orphaned, and the
 * invoice left linked to a missing row (GET returned `lines: []`). The form
 * sends the lines with their ids and wasn't affected; any other API client
 * was. Found by the front's e2e tests on 2026-10-09.
 *
 * The document middleware (services/lock-issued-invoices.js) drops `lines`
 * from updates of real invoices before the document service sees them.
 */

const { lockIssuedInvoiceLines } = require('../src/services/lock-issued-invoices');

const UID = 'api::emitted-invoice.emitted-invoice';

function mockStrapi(stored) {
  const findOne = jest.fn(async () => stored);
  global.strapi = { db: { query: jest.fn(() => ({ findOne })) } };
  return { findOne };
}

const context = (data, extra = {}) => ({ uid: UID, action: 'update', params: { documentId: 'doc-1', data }, ...extra });

describe('issued invoices keep their lines (issues/023)', () => {
  afterEach(() => { delete global.strapi; });

  it('drops the lines of an update to a real invoice', async () => {
    mockStrapi({ id: 1, state: 'real' });
    const next = jest.fn(async () => 'result');
    const ctx = context({ lines: [{ concept: 'x', base: 1, quantity: 1 }], paid: true });
    expect(await lockIssuedInvoiceLines(ctx, next)).toBe('result');
    expect(ctx.params.data).toEqual({ paid: true });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves drafts alone', async () => {
    mockStrapi({ id: 1, state: 'draft' });
    const lines = [{ concept: 'x', base: 1, quantity: 1 }];
    const ctx = context({ lines });
    await lockIssuedInvoiceLines(ctx, jest.fn());
    expect(ctx.params.data.lines).toBe(lines);
  });

  it('does not look up the invoice when the update has no lines, or for other types and actions', async () => {
    const { findOne } = mockStrapi({ id: 1, state: 'real' });
    await lockIssuedInvoiceLines(context({ paid: true }), jest.fn());
    await lockIssuedInvoiceLines(context({ lines: [] }, { uid: 'api::quote.quote' }), jest.fn());
    await lockIssuedInvoiceLines(context({ lines: [] }, { action: 'create' }), jest.fn());
    expect(findOne).not.toHaveBeenCalled();
  });

  it('lets the update that issues the invoice through (it still is a draft)', async () => {
    mockStrapi({ id: 1, state: 'draft' });
    const ctx = context({ state: 'real', code: 'ESBORRANY', lines: [{ id: 9 }] });
    await lockIssuedInvoiceLines(ctx, jest.fn());
    expect(ctx.params.data.lines).toEqual([{ id: 9 }]);
  });
});
