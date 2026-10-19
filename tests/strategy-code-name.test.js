'use strict';

/**
 * issues/183: a strategy created with only its code stored code_name
 * «<code> - undefined», which the project's «Estratègies» picker showed, and
 * the admin form offered «Nom de codi» although the lifecycle overwrites it.
 */

const path = require('path');

const lifecycles = require('../src/api/strategy/content-types/strategy/lifecycles');

function mockStrapi(existing) {
  const query = { findOne: jest.fn(async () => existing) };
  global.strapi = { db: { query: jest.fn(() => query) } };
  return query;
}

afterEach(() => {
  delete global.strapi;
});

describe('strategy code_name', () => {
  it.each([
    [{ code: 'E1', name: 'Energia' }, 'E1 - Energia'],
    [{ code: 'E1' }, 'E1'],
    [{ code: 'E1', name: null }, 'E1'],
    [{ code: 'E1', name: '  ' }, 'E1'],
  ])('on create %j → %s', async (data, expected) => {
    await lifecycles.beforeCreate({ params: { data } });
    expect(data.code_name).toBe(expected);
  });

  it('on a partial update reads the missing field back', async () => {
    const query = mockStrapi({ code: 'E1', name: 'Energia' });
    const data = { name: 'Energies' };
    await lifecycles.beforeUpdate({ params: { data, where: { id: 3 } } });
    expect(query.findOne).toHaveBeenCalledWith({ where: { id: 3 }, select: ['code', 'name'] });
    expect(data.code_name).toBe('E1 - Energies');
  });

  it('clearing the name leaves just the code', async () => {
    mockStrapi({ code: 'E1', name: 'Energia' });
    const data = { name: null };
    await lifecycles.beforeUpdate({ params: { data, where: { id: 3 } } });
    expect(data.code_name).toBe('E1');
  });

  it('ignores a code_name sent by the client and leaves it alone when code and name are untouched', async () => {
    const query = mockStrapi({ code: 'E1', name: 'Energia' });
    const data = { description: 'x', code_name: 'hand-written' };
    await lifecycles.beforeUpdate({ params: { data, where: { id: 3 } } });
    expect(data).toEqual({ description: 'x' });
    expect(query.findOne).not.toHaveBeenCalled();
  });

  it('the admin form does not offer «Nom de codi»', async () => {
    jest.resetModules();
    global.strapi = {
      dirs: { app: { root: path.join(__dirname, '..') } },
      db: { query: () => ({ findOne: async ({ where }) => ({ id: where.id, permissions: [{ permission: 'admin' }] }) }) },
    };
    const controller = require('../src/api/entity-metadata/controllers/entity-metadata');
    const body = await controller.adminEntities({ state: { user: { id: 1 } } });
    const strategy = body.entities.find((e) => e.name === 'strategy');
    expect(strategy.attributes.code).toBeDefined();
    expect(strategy.attributes.code_name).toBeUndefined();
  });
});
