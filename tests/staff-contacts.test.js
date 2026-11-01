'use strict';

/**
 * issues/392 (security review round 2, 2026-10-31): on a copy of La
 * Diligència a driver changed the e-mail of client contact 1459 (no owner),
 * where its invoices are sent. Drivers and the office without full access
 * could edit, delete or unify any contact: clients, energy partners.
 *
 * Guard: they change, delete and unify delivery points (contacts with an owner) only.
 */
const CONTACTS = { 1459: { id: 1459, owner: null }, 2239: { id: 2239, owner: { id: 50 } } };

function setup(permissions) {
  jest.resetModules();
  const strapi = {
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where }) => {
          if (uid === 'plugin::users-permissions.user') return { id: where.id, permissions: permissions.map((p) => ({ permission: p })) };
          if (uid === 'api::contact.contact') return CONTACTS[where.id] || null;
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

async function call(middleware, handler, { method, id, body }) {
  const ctx = {
    method,
    query: {},
    params: id ? { id: String(id) } : {},
    request: { body },
    state: { user: { id: 34 }, route: { handler, info: { apiName: 'contact' } }, v3: id ? { numericId: id } : undefined },
  };
  const next = jest.fn();
  await middleware(ctx, next);
  return next;
}

describe('logistics staff and contacts (issues/392)', () => {
  it.each([['orders_delivery'], ['orders_admin']])('%s edits and deletes delivery points', async (permission) => {
    const middleware = setup([permission]);
    expect(await call(middleware, 'api::contact.contact.update', { method: 'PUT', id: 2239, body: { data: { address: 'C/ Nou 1' } } })).toHaveBeenCalled();
    expect(await call(middleware, 'api::contact.contact.delete', { method: 'DELETE', id: 2239 })).toHaveBeenCalled();
  });

  it.each([['orders_delivery'], ['orders_admin']])('%s can’t touch a client contact', async (permission) => {
    const middleware = setup([permission]);
    await expect(
      call(middleware, 'api::contact.contact.update', { method: 'PUT', id: 1459, body: { data: { contact_email: 'x@y.z' } } }),
    ).rejects.toMatchObject({ name: 'ForbiddenError' });
    await expect(call(middleware, 'api::contact.contact.delete', { method: 'DELETE', id: 1459 })).rejects.toMatchObject({
      name: 'ForbiddenError',
    });
    await expect(
      call(middleware, 'api::contact.contact.unify', { method: 'POST', body: { sourceContactId: 2239, targetContactId: 1459 } }),
    ).rejects.toMatchObject({ name: 'ForbiddenError' });
  });

  it('full-access users keep editing clients', async () => {
    const middleware = setup(['projects']);
    expect(await call(middleware, 'api::contact.contact.update', { method: 'PUT', id: 1459, body: { data: { contact_email: 'x@y.z' } } })).toHaveBeenCalled();
  });
});

describe('points migrated with an owner link to a missing user (issues/392)', () => {
  it('still count as delivery points', async () => {
    jest.resetModules();
    const strapi = {
      db: {
        query: jest.fn((uid) => ({
          findOne: jest.fn(async ({ where }) =>
            uid === 'plugin::users-permissions.user'
              ? { id: where.id, permissions: [{ permission: 'orders_delivery' }] }
              : { id: 1, owner: null },
          ),
          findMany: jest.fn(async () => []),
        })),
        metadata: { get: () => ({ attributes: { owner: { joinTable: { name: 'contacts_owner_lnk', joinColumn: { name: 'contact_id' } } } } }) },
        connection: jest.fn(() => ({ where: () => ({ first: async () => ({ contact_id: 1, user_id: 0 }) }) })),
      },
      contentTypes: {},
      components: {},
    };
    const middleware = require('../src/middlewares/app-permissions')({}, { strapi });
    const ctx = {
      method: 'PUT',
      query: {},
      params: { id: '1' },
      request: { body: { data: { notes_delivery: 'x' } } },
      state: { user: { id: 34 }, route: { handler: 'api::contact.contact.update', info: { apiName: 'contact' } }, v3: { numericId: 1 } },
    };
    const next = jest.fn();
    await middleware(ctx, next);
    expect(next).toHaveBeenCalled();
  });
});
