'use strict';

/**
 * issues/140 (2026-10-18): holidays for everyone (Festiu Estatal, Festiu
 * Catalunya…: festive types with personal = false) could only be loaded on the
 * server, the «Festiu» dialog offered personal types only. The dialog now
 * offers them to admins, and the API refuses them to anyone else (the hours
 * screens can still write personal holidays).
 */

const TYPES = { 1: { id: 1, personal: false }, 4: { id: 4, personal: true } };
const FESTIVES = { 10: { id: 10, festive_type: TYPES[1] }, 11: { id: 11, festive_type: TYPES[4] } };
const ADMIN = 1;
const WORKER = 2;

function setup() {
  jest.resetModules();
  jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
  jest.doMock('../src/services/app-permissions', () => ({ isAppAdmin: jest.fn(async (id) => id === ADMIN) }));
  const strapi = {
    db: {
      query: (uid) => ({
        findOne: jest.fn(async ({ where }) => (uid === 'api::festive-type.festive-type' ? TYPES[where.id] : FESTIVES[where.id]) || null),
      }),
    },
  };
  const controller = require('../src/api/festive/controllers/festive')({ strapi });
  const core = { create: jest.fn(async () => 'created'), update: jest.fn(async () => 'updated'), delete: jest.fn(async () => 'deleted') };
  Object.setPrototypeOf(controller, core);
  return { controller, core };
}

const ctx = (user, body, id) => ({
  state: { user: { id: user } },
  request: { body },
  params: id ? { id: String(id) } : {},
  forbidden: jest.fn(() => 'forbidden'),
});

describe('holidays for everyone are for admins (issues/140)', () => {
  it('refuses a worker creating a holiday for everyone', async () => {
    const { controller, core } = setup();
    const c = ctx(WORKER, { data: { date: '2027-01-01', festive_type: 1 } });
    expect(await controller.create(c)).toBe('forbidden');
    expect(core.create).not.toHaveBeenCalled();
  });

  it('lets a worker create a personal holiday', async () => {
    const { controller, core } = setup();
    expect(await controller.create(ctx(WORKER, { data: { date: '2027-08-03', festive_type: { id: 4 }, users_permissions_user: WORKER } }))).toBe('created');
    expect(core.create).toHaveBeenCalled();
  });

  it('lets an admin create a holiday for everyone (flat v3 body too)', async () => {
    const { controller } = setup();
    expect(await controller.create(ctx(ADMIN, { date: '2027-01-01', festive_type: 1 }))).toBe('created');
  });

  it('refuses a worker changing or deleting a holiday for everyone', async () => {
    const { controller, core } = setup();
    expect(await controller.update(ctx(WORKER, { data: { date: '2027-01-02' } }, 10))).toBe('forbidden');
    expect(await controller.delete(ctx(WORKER, {}, 10))).toBe('forbidden');
    expect(core.update).not.toHaveBeenCalled();
    expect(core.delete).not.toHaveBeenCalled();
  });

  it('refuses turning a personal holiday into one for everyone', async () => {
    const { controller } = setup();
    expect(await controller.update(ctx(WORKER, { data: { festive_type: 1 } }, 11))).toBe('forbidden');
  });

  it('lets a worker change and delete her personal holiday', async () => {
    const { controller } = setup();
    expect(await controller.update(ctx(WORKER, { data: { date: '2027-08-04' } }, 11))).toBe('updated');
    expect(await controller.delete(ctx(WORKER, {}, 11))).toBe('deleted');
  });
});
