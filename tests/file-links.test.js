'use strict';

/**
 * issues/387 (security review round 2, 2026-10-31): upload ids are sequential
 * and /uploads is public. A member created an orders import with
 * `{"file": 554}` and got the URL of a received expense's PDF (a fine); any id
 * gave any document. `admin_energy` could do the same through an energy
 * partner's `documents`.
 *
 * Guards: users without full access can't set an orders import's file (the
 * upload attaches it), and only link to a partner files that are not linked to
 * anything else (the ones just uploaded) or already were hers.
 */
const ME = 100;

function setup(permissions, { linked = [], partnerDocs = [] } = {}) {
  jest.resetModules();
  const strapi = {
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where }) => {
          if (uid === 'plugin::users-permissions.user') {
            return { id: where.id, permissions: permissions.map((p) => ({ permission: p })) };
          }
          if (uid === 'api::contact.contact') return { id: 5, documents: partnerDocs.map((id) => ({ id })) };
          return null;
        }),
        findMany: jest.fn(async () => []),
      })),
      connection: jest.fn(() => ({
        whereIn: (col, ids) => ({ select: async () => ids.filter((id) => linked.includes(id)).map((id) => ({ file_id: id })) }),
      })),
    },
    contentTypes: {},
    components: {},
  };
  return require('../src/middlewares/app-permissions')({}, { strapi });
}

async function call(middleware, handler, body, params = {}) {
  const ctx = {
    method: 'POST',
    query: {},
    params,
    request: { body },
    state: { user: { id: ME }, route: { handler, info: { apiName: handler.split('::')[1].split('.')[0] } } },
  };
  const next = jest.fn();
  await middleware(ctx, next);
  return { ctx, next };
}

describe('linking uploaded files (issues/387)', () => {
  it.each([['orders'], ['orders_admin'], ['orders_delivery', 'orders']])(
    'an orders import drops the file it is sent (%s)',
    async (...permissions) => {
      const middleware = setup(permissions);
      const { ctx, next } = await call(middleware, 'api::orders-import.orders-import.create', { data: { file: 554 } });
      expect(next).toHaveBeenCalled();
      expect(ctx.request.body.data.file).toBeUndefined();
    },
  );

  it('admin_energy links a file she just uploaded and keeps the partner’s own', async () => {
    const middleware = setup(['admin_energy'], { linked: [10], partnerDocs: [10] });
    const { next } = await call(middleware, 'api::energy.energy.updatePartner', { documents: [10, 11] }, { id: '5' });
    expect(next).toHaveBeenCalled();
  });

  it('admin_energy can’t link a file that belongs to another record', async () => {
    const middleware = setup(['admin_energy'], { linked: [554], partnerDocs: [10] });
    await expect(
      call(middleware, 'api::energy.energy.updatePartner', { documents: [10, 554] }, { id: '5' }),
    ).rejects.toMatchObject({ name: 'ForbiddenError' });
    await expect(call(middleware, 'api::energy.energy.createPartner', { documents: [{ id: 554 }] })).rejects.toMatchObject({
      name: 'ForbiddenError',
    });
  });

  it('full-access users keep linking any file', async () => {
    const middleware = setup(['projects'], { linked: [554] });
    const { ctx, next } = await call(middleware, 'api::orders-import.orders-import.create', { data: { file: 554 } });
    expect(next).toHaveBeenCalled();
    expect(ctx.request.body.data.file).toBe(554);
  });
});
