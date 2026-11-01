'use strict';

/**
 * issues/385 (security review round 2, 2026-10-31): «Enviar per correu» read
 * `./public${invoice.pdf}` and `pdf` could be set by the client. On a copy of
 * Arran de Terra a `projects` user (not admin) set it to
 * `/../../…/proc/self/environ` and the mail carried the process environment
 * (shared SSO keys, JWT secret, DB password).
 *
 * Guards: only files inside public/uploads/documents are read, and the client's
 * `pdf` is dropped from invoice and quote writes.
 */
const path = require('path');

describe('documentPdfPath (issues/385)', () => {
  const app = { dirs: { static: { public: '/opt/app/public' } } };
  const { documentPdfPath } = require('../src/services/document-pdf-path');

  it('maps a stored document PDF into uploads/documents', () => {
    expect(documentPdfPath('/uploads/documents/Factura-Coop-2026-001-Habc.pdf', app)).toBe(
      path.resolve('/opt/app/public/uploads/documents/Factura-Coop-2026-001-Habc.pdf'),
    );
  });

  it.each([
    '/../../../../proc/self/environ',
    '/uploads/documents/../../../../etc/hostname',
    '/uploads/documents/../latest.sql.gz',
    '/uploads/key_abc.json',
    '/uploads/documents/',
    '../uploads/documents/x.pdf',
    null,
    42,
  ])('refuses %p', (pdf) => {
    expect(documentPdfPath(pdf, app)).toBeNull();
  });
});

describe('client writes of pdf (issues/385)', () => {
  function setup(permissions) {
    jest.resetModules();
    const strapi = {
      db: {
        query: jest.fn(() => ({
          findOne: jest.fn(async ({ where }) => ({ id: where.id, permissions: permissions.map((p) => ({ permission: p })) })),
          findMany: jest.fn(async () => []),
        })),
      },
      contentTypes: {},
      components: {},
    };
    return require('../src/middlewares/app-permissions')({}, { strapi });
  }
  async function send(handler, body, method = 'PUT') {
    const middleware = setup(['projects']);
    const ctx = {
      method,
      query: {},
      params: { id: '7' },
      request: { body },
      state: { user: { id: 1 }, route: { handler, info: { apiName: handler.split('::')[1].split('.')[0] } } },
    };
    await middleware(ctx, jest.fn());
    return ctx.request.body;
  }

  it.each([
    'api::emitted-invoice.emitted-invoice.update',
    'api::emitted-invoice.emitted-invoice.create',
    'api::quote.quote.update',
  ])('%s drops pdf, also for full-access users', async (handler) => {
    const body = await send(handler, { data: { comments: 'x', pdf: '/../../proc/self/environ' } });
    expect(body.data).toEqual({ comments: 'x' });
    const flat = await send(handler, { comments: 'x', pdf: '/uploads/documents/a.pdf' });
    expect(flat).toEqual({ comments: 'x' });
  });

  it('leaves other types alone', async () => {
    const body = await send('api::verifactu-declaration.verifactu-declaration.update', { data: { pdf: 'https://x' } });
    expect(body.data.pdf).toBe('https://x');
  });
});

describe('sendInvoiceByEmail refuses a pdf outside uploads/documents (issues/385)', () => {
  it('answers 400 and reads nothing', async () => {
    jest.resetModules();
    const fs = require('fs');
    const read = jest.spyOn(fs, 'readFileSync');
    const send = jest.fn();
    global.strapi = {
      dirs: { static: { public: '/opt/app/public' } },
      db: {
        query: () => ({
          findOne: async () => ({ id: 7, code: 'ESBORRANY', pdf: '/../../proc/self/environ', contact: { contact_email: 'a@b.c' } }),
        }),
      },
      plugin: () => ({ service: () => ({ send }) }),
      contentType: () => ({ attributes: {} }),
      log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    };
    const factory = require('../src/api/emitted-invoice/controllers/emitted-invoice');
    const controller = typeof factory === 'function' ? factory({ strapi: global.strapi }) : factory;
    const ctx = { params: { id: '7' }, send: jest.fn() };
    await controller.sendInvoiceByEmail(ctx);
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ done: false }), 400);
    expect(read).not.toHaveBeenCalledWith(expect.stringContaining('environ'));
    expect(send).not.toHaveBeenCalled();
    read.mockRestore();
  });
});
