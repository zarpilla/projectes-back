'use strict';

/**
 * issues/093 (2026-10-16): Diligència had «Barcelona» and «Barcelona », each
 * with its own routes (and one route linked twice), «Manlleu» / «Manlleu »
 * and «Cabrils» twice, one of them without routes. Town names are now
 * trimmed and unique ignoring case and spaces, and a startup script merges
 * the existing duplicates into the oldest town.
 */

describe('city names (issues/093)', () => {
  let lifecycles;
  const stored = [{ id: 82, name: 'Barcelona' }, { id: 164, name: 'Manlleu' }];

  beforeEach(() => {
    jest.resetModules();
    global.strapi = { db: { query: () => ({ findMany: async () => stored }) } };
    lifecycles = require('../src/api/city/content-types/city/lifecycles');
  });
  afterEach(() => { delete global.strapi; });

  it('trims the name', async () => {
    const event = { params: { data: { name: '  Sant  Vicenç de Torelló ' } } };
    await lifecycles.beforeCreate(event);
    expect(event.params.data.name).toBe('Sant Vicenç de Torelló');
  });

  it('refuses a town that exists with other spaces or case', async () => {
    await expect(lifecycles.beforeCreate({ params: { data: { name: 'barcelona ' } } }))
      .rejects.toThrow('La població «barcelona» ja existeix');
    await expect(lifecycles.beforeUpdate({ params: { where: { id: 82 }, data: { name: 'Manlleu' } } }))
      .rejects.toThrow('ja existeix');
  });

  it('lets a town keep or fix its own name', async () => {
    const event = { params: { where: { id: 164 }, data: { name: 'Manlleu ' } } };
    await lifecycles.beforeUpdate(event);
    expect(event.params.data.name).toBe('Manlleu');
    await lifecycles.beforeUpdate({ params: { where: { id: 82 }, data: { order: 2 } } });
  });
});
