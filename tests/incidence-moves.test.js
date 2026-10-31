'use strict';

/**
 * issues/390 (security review round 2, 2026-10-31): on a copy of La
 * Diligència a member sent `PUT /api/orders/<hers> {"data":{"incidences":{"id":1}}}`
 * and another member's incidence moved onto her order (Strapi takes one row
 * on a to-many relation as a `set`). Replies sent as something other than the
 * screen's list would replace the stored ones.
 *
 * Guards: without full access a to-many relation is only written as a list,
 * and an incidence's replies only as a list (the controller keeps the stored
 * ones and appends).
 */
const ME = 32;
const ORDER = { id: 24893, owner: { id: ME }, contact: { id: 7 }, status: 'pending' };

function setup(permissions) {
  jest.resetModules();
  const strapi = {
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where }) => {
          if (uid === 'plugin::users-permissions.user') return { id: where.id, permissions: permissions.map((p) => ({ permission: p })) };
          if (uid === 'api::order.order') return ORDER;
          if (uid === 'api::incidence.incidence') return { id: 1, state: 'open', createdAt: new Date().toISOString(), order: { id: ORDER.id } };
          return null;
        }),
        findMany: jest.fn(async ({ where } = {}) => (uid === 'api::contact.contact' ? [{ id: 7 }] : [])),
        count: jest.fn(async () => 0),
      })),
    },
    contentTypes: {
      'api::order.order': {
        attributes: {
          incidences: { type: 'relation', relation: 'oneToMany', target: 'api::incidence.incidence', mappedBy: 'order' },
          owner: { type: 'relation', relation: 'manyToOne', target: 'plugin::users-permissions.user' },
        },
      },
      'api::incidence.incidence': { attributes: { order: { type: 'relation', relation: 'manyToOne', target: 'api::order.order' } } },
    },
    components: {},
  };
  return require('../src/middlewares/app-permissions')({}, { strapi });
}

async function put(middleware, handler, data, id) {
  const ctx = {
    method: 'PUT',
    query: {},
    params: { id: String(id) },
    request: { body: { data } },
    state: { user: { id: ME }, route: { handler, info: { apiName: handler.split('::')[1].split('.')[0] } }, v3: { numericId: id } },
  };
  const next = jest.fn();
  await middleware(ctx, next);
  return { ctx, next };
}

describe('incidences (issues/390)', () => {
  it.each([[{ id: 1 }], [{ documentId: 'abc' }], [1]])('refuses one incidence %p on her order', async (value) => {
    const middleware = setup(['orders']);
    await expect(put(middleware, 'api::order.order.update', { incidences: value }, ORDER.id)).rejects.toMatchObject({
      name: 'ForbiddenError',
    });
  });

  it('lets the order form send its list of incidences', async () => {
    const middleware = setup(['orders']);
    const { next } = await put(middleware, 'api::order.order.update', { incidences: [{ description: 'Caixa trencada' }] }, ORDER.id);
    expect(next).toHaveBeenCalled();
  });

  it('refuses replies that are not the list', async () => {
    const middleware = setup(['orders']);
    await expect(
      put(middleware, 'api::incidence.incidence.update', { incidence_response: { text: 'x' } }, 1),
    ).rejects.toMatchObject({ name: 'ForbiddenError' });
    const { next } = await put(middleware, 'api::incidence.incidence.update', { incidence_response: [{ text: 'gràcies' }] }, 1);
    expect(next).toHaveBeenCalled();
  });
});
