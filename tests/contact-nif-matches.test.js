'use strict';

/**
 * The contact form warns when the NIF is already on another contact (decided
 * 2026-10-30: arrandeterra had 9 NIFs repeated over 24 contacts, resilience 23
 * over 57). Delivery points are left out: in Diligència one organisation has
 * several points under one NIF (83 such groups), and they must not warn.
 */

const { nifKey, nifMatches, findNifMatches } = require('../src/api/contact/services/nif-matches');

const contacts = [
  { id: 1, name: 'Coop A', nif: 'B-12.345.678', owner: null },
  { id: 2, name: 'Coop A bis', nif: 'b12345678', owner: null },
  { id: 3, name: 'Punt 1', nif: 'B12345678', owner: { id: 9 } },
  { id: 4, name: 'Altra', nif: 'F87654321', owner: null },
  { id: 5, name: 'Sense NIF', nif: null, owner: null },
];

describe('nifKey', () => {
  it('ignores case, spaces, dashes and dots', () => {
    expect(nifKey(' b-12.345 678 ')).toBe('B12345678');
    expect(nifKey(null)).toBe('');
  });
});

describe('nifMatches', () => {
  it('finds the other contacts with the same NIF, written differently', () => {
    expect(nifMatches(contacts, 'B 12345678', 1).map((c) => c.id)).toEqual([2]);
  });

  it('leaves delivery points out', () => {
    expect(nifMatches(contacts, 'B12345678').map((c) => c.id)).toEqual([1, 2]);
  });

  it('excludes the contact being edited, also when the id comes as a string', () => {
    expect(nifMatches(contacts, 'F87654321', '4')).toEqual([]);
  });

  it('does not warn on an empty or too short NIF', () => {
    expect(nifMatches(contacts, '')).toEqual([]);
    expect(nifMatches([{ id: 6, nif: '-', owner: null }], '-')).toEqual([]);
  });

  it('answers only id, name, trade name and NIF', () => {
    expect(nifMatches(contacts, 'F87654321')).toEqual([
      { id: 4, name: 'Altra', trade_name: undefined, nif: 'F87654321' },
    ]);
  });
});

describe('findNifMatches', () => {
  it('narrows the query by the last digits and populates only the owner id', async () => {
    const findMany = jest.fn().mockResolvedValue(contacts);
    const strapi = { db: { query: () => ({ findMany }) } };
    const result = await findNifMatches(strapi, 'b-12345678', 2);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { nif: { $containsi: '5678' } },
        populate: { owner: { select: ['id'] } },
      })
    );
    expect(result.map((c) => c.id)).toEqual([1]);
  });

  it('does not query for a short NIF', async () => {
    const findMany = jest.fn();
    expect(await findNifMatches({ db: { query: () => ({ findMany }) } }, '12', null)).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
