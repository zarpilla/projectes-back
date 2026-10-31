'use strict';

/**
 * issues/373 (security review 2026-10-31): the upload action is allowed to the
 * logistics and energy users so they can add files, but Strapi serves file
 * replacement (`POST /upload?id=<file>` with a file) and renaming (without
 * one) through the same action. A member overwrote the entity's logo on a copy
 * of La Diligència, and could have done the same with received invoices or
 * certificates.
 *
 * Guards: users without full access only add new files, unattached or for an
 * orders import of their own, and never an SVG.
 */

const ME = 100;
const OTHER = 200;
const UPLOAD = 'plugin::upload.content-api.upload';

function setup(permissions, imports = {}) {
  jest.resetModules();
  const strapi = {
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where }) => {
          if (uid === 'plugin::users-permissions.user') {
            return { id: where.id, permissions: permissions.map((permission) => ({ permission })) };
          }
          if (uid === 'api::orders-import.orders-import') return imports[where.id] || null;
          return null;
        }),
        findMany: jest.fn(async () => []),
      })),
    },
    contentTypes: {},
    components: {},
  };
  return require('../src/middlewares/app-permissions')({}, { strapi });
}

function ctxFor({ query = {}, body = {}, files } = {}) {
  return {
    method: 'POST',
    query,
    params: {},
    request: { body, files: files ? { files } : undefined },
    state: { user: { id: ME }, route: { handler: UPLOAD, info: { pluginName: 'upload' } } },
  };
}

async function run(middleware, ctx) {
  const next = jest.fn(async () => {
    ctx.body = [];
  });
  await middleware(ctx, next);
  return next;
}

const CSV = { originalFilename: 'comandes.csv', mimetype: 'text/csv', size: 10 };
const SVG = { originalFilename: 'logo.svg', mimetype: 'image/svg+xml', size: 10 };
const PDF = { originalFilename: 'dni.pdf', mimetype: 'application/pdf', size: 10 };
const MY_IMPORT = { 5: { id: 5, users_permissions_user: { id: ME } }, 6: { id: 6, users_permissions_user: { id: OTHER } } };

describe('uploads by users without full access (issues/373)', () => {
  it.each([['orders'], ['orders_admin'], ['orders_delivery'], ['admin_energy']])(
    '%s may not replace or rename a file',
    async (permission) => {
      const middleware = setup([permission]);
      await expect(run(middleware, ctxFor({ query: { id: '88' }, files: CSV }))).rejects.toMatchObject({
        name: 'ForbiddenError',
      });
      await expect(
        run(middleware, ctxFor({ query: { id: '88' }, body: { fileInfo: '{"name":"x"}' } })),
      ).rejects.toMatchObject({ name: 'ForbiddenError' });
    },
  );

  it('a member uploads the CSV of her own orders import', async () => {
    const middleware = setup(['orders'], MY_IMPORT);
    const body = { ref: 'api::orders-import.orders-import', refId: '5', field: 'file' };
    expect(await run(middleware, ctxFor({ body, files: CSV }))).toHaveBeenCalled();
  });

  it.each([
    ['another user import', { ref: 'api::orders-import.orders-import', refId: '6', field: 'file' }],
    ['a missing import', { ref: 'api::orders-import.orders-import', refId: '9', field: 'file' }],
    ['another field', { ref: 'api::orders-import.orders-import', refId: '5', field: 'documents' }],
    ['the entity', { ref: 'api::me.me', refId: '1', field: 'face_certificate' }],
    ['a received invoice', { ref: 'api::received-invoice.received-invoice', refId: '43', field: 'documents' }],
    ['a ref sent twice', { ref: ['api::orders-import.orders-import', 'api::me.me'], refId: '5', field: 'file' }],
    ['a refId without ref', { refId: '5', field: 'file' }],
  ])('refuses attaching to %s', async (_label, body) => {
    const middleware = setup(['orders'], MY_IMPORT);
    await expect(run(middleware, ctxFor({ body, files: CSV }))).rejects.toMatchObject({ name: 'ForbiddenError' });
  });

  it('admin_energy uploads unattached documents', async () => {
    const middleware = setup(['admin_energy']);
    expect(await run(middleware, ctxFor({ files: [PDF, PDF] }))).toHaveBeenCalled();
  });

  it('refuses an SVG, also among other files', async () => {
    const middleware = setup(['admin_energy']);
    await expect(run(middleware, ctxFor({ files: [PDF, SVG] }))).rejects.toMatchObject({ name: 'ValidationError' });
    await expect(
      run(middleware, ctxFor({ files: { ...SVG, mimetype: 'application/octet-stream' } })),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('leaves full-access users alone (logos, certificates, replacing files)', async () => {
    const middleware = setup(['projects']);
    expect(await run(middleware, ctxFor({ query: { id: '88' }, files: SVG }))).toHaveBeenCalled();
  });
});
