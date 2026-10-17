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

describe('merging duplicate towns (issues/093)', () => {
  const { planCityMerge } = require('../src/services/merge-duplicate-cities');

  it('keeps the oldest town, moves the routes it lacks and drops repeated links', () => {
    const cities = [
      { id: 82, name: 'Barcelona' }, { id: 183, name: 'Barcelona ' },
      { id: 119, name: 'Manlleu ' }, { id: 164, name: 'Manlleu' },
      { id: 130, name: 'Cabrils' }, { id: 292, name: 'Cabrils' },
      { id: 252, name: 'Ullestret' }, { id: 300, name: ' Llerona' },
    ];
    const links = [
      { city_route_id: 1, city_id: 82, route_id: 10 },
      { city_route_id: 2, city_id: 82, route_id: 11 },
      { city_route_id: 3, city_id: 82, route_id: 11 }, // the same route twice
      { city_route_id: 4, city_id: 183, route_id: 10 }, // already on 82
      { city_route_id: 5, city_id: 183, route_id: 12 }, // moves to 82
      { city_route_id: 6, city_id: 119, route_id: 20 },
      { city_route_id: 7, city_id: 164, route_id: 20 },
      { city_route_id: 8, city_id: 130, route_id: 30 },
    ];
    expect(planCityMerge(cities, links)).toEqual({
      renames: [{ id: 300, from: ' Llerona', name: 'Llerona' }],
      merges: [
        { keep: 82, from: 'Barcelona', name: 'Barcelona', others: [183], redundant: [3, 4] },
        { keep: 119, from: 'Manlleu ', name: 'Manlleu', others: [164], redundant: [7] },
        { keep: 130, from: 'Cabrils', name: 'Cabrils', others: [292], redundant: [] },
      ],
    });
  });

  it('changes nothing when every town is unique and trimmed', () => {
    expect(planCityMerge([{ id: 1, name: 'Vic' }], [{ city_route_id: 1, city_id: 1, route_id: 1 }]))
      .toEqual({ renames: [], merges: [] });
  });
});
