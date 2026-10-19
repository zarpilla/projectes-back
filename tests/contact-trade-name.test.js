'use strict';

/**
 * issues/215 (the user's decision, 2026-10-19): «Nom comercial» is required
 * for delivery points (contacts with an owner). A point without it blanked
 * every order form (`option.trade_name.toString()`), and since 187 members see
 * every point. The check is in the contact lifecycles, so it holds for every
 * role and path; legacy points without it (36 in production) still save when
 * the write leaves the trade name alone.
 */

let STORED;

function load() {
  jest.resetModules();
  global.strapi = {
    db: {
      query: jest.fn(() => ({
        findOne: jest.fn(async ({ where }) => STORED[where.id] || null),
      })),
    },
  };
  return require('../src/api/contact/content-types/contact/lifecycles');
}

const create = (data) => load().beforeCreate({ params: { data } });
const update = (id, data) => load().beforeUpdate({ params: { where: { id }, data } });

describe('the trade name of a delivery point (issues/215)', () => {
  beforeEach(() => {
    STORED = {
      5: { id: 5, name: 'Llegat', trade_name: null, owner: { id: 100 } },
      6: { id: 6, name: 'Client', trade_name: null, owner: null },
      7: { id: 7, name: 'Punt', trade_name: 'El Punt', owner: { id: 100 } },
      8: { id: 8, name: 'Client', trade_name: 'El Client', owner: null },
    };
  });

  it.each([[{ owner: 100 }], [{ owner: { set: [{ id: 100 }] } }], [{ owner: { connect: [{ id: 100 }] } }]])(
    'refuses a new point without it (%j)',
    async (owner) => {
      for (const trade_name of [undefined, null, '', '  ']) {
        await expect(create({ name: 'Botiga', trade_name, ...owner })).rejects.toMatchObject({
          name: 'ValidationError',
          message: "El nom comercial és obligatori als punts d'entrega",
        });
      }
    },
  );

  it('accepts a new point with it, and a contact without owner without it', async () => {
    await expect(create({ name: 'Botiga', trade_name: 'La Botiga', owner: 100 })).resolves.toBeUndefined();
    await expect(create({ name: 'Client' })).resolves.toBeUndefined();
    await expect(create({ name: 'Client', owner: 0 })).resolves.toBeUndefined();
  });

  it('refuses emptying it on a point', async () => {
    await expect(update(7, { trade_name: '' })).rejects.toMatchObject({ name: 'ValidationError' });
    await expect(update(8, { trade_name: null, owner: 100 })).rejects.toMatchObject({
      name: 'ValidationError',
    });
  });

  it('lets a legacy point without it save when the write leaves it alone', async () => {
    await expect(update(5, { phone: '1' })).resolves.toBeUndefined();
    // the form sends it back empty, as it was
    await expect(update(5, { trade_name: null, phone: '1' })).resolves.toBeUndefined();
    await expect(update(8, { trade_name: '' })).resolves.toBeUndefined();
  });
});
