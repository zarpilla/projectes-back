'use strict';

/**
 * issues/361 (2026-10-27): the logistics simulator quotes an order from the
 * member's warehouse, so each member has a default one (`default_pickup`, a
 * private relation of the user). A member reads and sets her own; the office
 * (orders_admin) and the admins, anyone's. A farm pickup can't be the default.
 */

jest.mock('../src/services/app-permissions', () => ({
  appPermissionsOf: jest.fn(async (id) => ({ 1: ['orders_admin'], 5: ['orders'], 6: ['orders'] })[id] || []),
}));

const PICKUPS = {
  1: { id: 1, name: 'Magatzem Girona', alias: 'GI', pickup: false },
  2: { id: 2, name: 'Recollida en Finca', pickup: true },
};

function stub(users) {
  const update = jest.fn(async ({ where, data }) => {
    users[where.id] = { ...users[where.id], default_pickup: data.default_pickup ? PICKUPS[data.default_pickup] : null };
    return users[where.id];
  });
  global.strapi = {
    db: {
      query: (uid) =>
        uid === 'api::pickup.pickup'
          ? { findOne: async ({ where }) => PICKUPS[where.id] || null }
          : {
              findOne: async ({ where }) => users[where.id] || null,
              findMany: async () => Object.values(users),
              update,
            },
    },
  };
  return { update };
}

const ctx = (userId, params = {}, body) => ({ state: { user: { id: userId } }, params, request: { body } });

beforeEach(() => jest.resetModules());
afterEach(() => delete global.strapi);

describe('default warehouse of a member (issues/361)', () => {
  it('a member reads and sets her own', async () => {
    const users = { 5: { id: 5, default_pickup: null } };
    const { update } = stub(users);
    const { controllers } = require('../src/services/user-default-pickup');

    const read = ctx(5, { id: 'me' });
    await controllers.defaultPickup(read);
    expect(read.body).toEqual({ pickup: null });

    const write = ctx(5, { id: 'me' }, { pickup: 1 });
    await controllers.updateDefaultPickup(write);
    expect(update).toHaveBeenCalledWith({ where: { id: 5 }, data: { default_pickup: 1 } });
    expect(write.body).toEqual({ pickup: { id: 1, name: 'Magatzem Girona', alias: 'GI' } });
  });

  it("a member can't touch another member's; the office can", async () => {
    const users = { 5: { id: 5, default_pickup: null }, 6: { id: 6, default_pickup: null } };
    stub(users);
    const { controllers } = require('../src/services/user-default-pickup');

    await expect(controllers.updateDefaultPickup(ctx(5, { id: '6' }, { pickup: 1 }))).rejects.toMatchObject({
      name: 'ForbiddenError',
    });
    const office = ctx(1, { id: '6' }, { pickup: 1 });
    await controllers.updateDefaultPickup(office);
    expect(users[6].default_pickup).toEqual(PICKUPS[1]);

    const list = ctx(1);
    await controllers.defaultPickups(list);
    expect(list.body).toEqual([{ user: 6, pickup: { id: 1, name: 'Magatzem Girona', alias: 'GI' } }]);
    await expect(controllers.defaultPickups(ctx(5))).rejects.toMatchObject({ name: 'ForbiddenError' });
  });

  it('only a warehouse; null clears it', async () => {
    const users = { 5: { id: 5, default_pickup: PICKUPS[1] } };
    stub(users);
    const { controllers } = require('../src/services/user-default-pickup');

    await expect(controllers.updateDefaultPickup(ctx(5, { id: 'me' }, { pickup: 2 }))).rejects.toMatchObject({
      name: 'ValidationError',
    });
    await expect(controllers.updateDefaultPickup(ctx(5, { id: 'me' }, { pickup: 99 }))).rejects.toMatchObject({
      name: 'ValidationError',
    });
    const clear = ctx(5, { id: 'me' }, { pickup: null });
    await controllers.updateDefaultPickup(clear);
    expect(clear.body).toEqual({ pickup: null });
  });

  it('is reachable before the plugin routes and allowed to the logistics roles', () => {
    const { routes } = require('../src/services/user-default-pickup');
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /users/default-pickups',
      'GET /users/:id/default-pickup',
      'PUT /users/:id/default-pickup',
    ]);
  });
});
