'use strict';

/**
 * issues/394 (security review round 2, 2026-10-31): saved pivot views had no
 * owner, so workers and the office could overwrite or delete the views the
 * admins use. The server records who saves a view; without full access only
 * one's own views can be changed or deleted.
 */
const ME = 66;
const VIEWS = {
  1: { id: 1, identifier: 'dedication-pivot', owner_user: ME },
  2: { id: 2, identifier: 'dedication-pivot', owner_user: 20 },
  3: { id: 3, identifier: 'dedication-pivot', owner_user: null },
};

function setup(permissions) {
  jest.resetModules();
  const strapi = {
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where }) =>
          uid === 'plugin::users-permissions.user'
            ? { id: where.id, permissions: permissions.map((p) => ({ permission: p })) }
            : VIEWS[where.id] || null,
        ),
        findMany: jest.fn(async () => []),
      })),
    },
    contentTypes: {},
    components: {},
  };
  return require('../src/middlewares/app-permissions')({}, { strapi });
}

async function call(middleware, action, { method, id, body }) {
  const ctx = {
    method,
    query: {},
    params: id ? { id: String(id) } : {},
    request: { body },
    state: { user: { id: ME }, route: { handler: `api::pivot-table-view.pivot-table-view.${action}`, info: { apiName: 'pivot-table-view' } }, v3: id ? { numericId: id } : undefined },
  };
  const next = jest.fn();
  await middleware(ctx, next);
  return { ctx, next };
}

describe('pivot views (issues/394)', () => {
  it('records who saves a view, whatever is sent', async () => {
    const { ctx } = await call(setup(['hours']), 'create', {
      method: 'POST',
      body: { data: { identifier: 'dedication-pivot', name: 'meva', owner_user: 20 } },
    });
    expect(ctx.request.body.data.owner_user).toBe(ME);
  });

  it('a worker changes and deletes her own views only', async () => {
    const middleware = setup(['hours']);
    expect((await call(middleware, 'update', { method: 'PUT', id: 1, body: { data: { name: 'x' } } })).next).toHaveBeenCalled();
    for (const id of [2, 3]) {
      await expect(call(middleware, 'update', { method: 'PUT', id, body: { data: { name: 'x' } } })).rejects.toMatchObject({ name: 'ForbiddenError' });
      await expect(call(middleware, 'delete', { method: 'DELETE', id })).rejects.toMatchObject({ name: 'ForbiddenError' });
    }
    expect((await call(middleware, 'findOne', { method: 'GET', id: 2 })).next).toHaveBeenCalled();
  });

  it('full-access users keep changing every view, and can’t forge the owner', async () => {
    const middleware = setup(['projects']);
    const { ctx, next } = await call(middleware, 'update', { method: 'PUT', id: 2, body: { data: { name: 'x', owner_user: 1 } } });
    expect(next).toHaveBeenCalled();
    expect(ctx.request.body.data.owner_user).toBeUndefined();
  });
});
