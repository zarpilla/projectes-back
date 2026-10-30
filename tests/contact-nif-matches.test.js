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
  const stub = (ids, found) => {
    const whereRaw = jest.fn().mockResolvedValue(ids.map((id) => ({ id })));
    const connection = jest.fn(() => ({ select: () => ({ whereRaw }) }));
    const findMany = jest.fn().mockResolvedValue(found);
    return { strapi: { db: { connection, query: () => ({ findMany }) } }, whereRaw, findMany };
  };

  it('finds the ids by the normalised NIF in SQL, then populates only the owner id', async () => {
    const { strapi, whereRaw, findMany } = stub([1, 2], contacts);
    const result = await findNifMatches(strapi, 'b-12345678', 2);
    expect(whereRaw).toHaveBeenCalledWith(expect.stringContaining('REPLACE'), ['B12345678']);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { $in: [1, 2] } }, populate: { owner: { select: ['id'] } } })
    );
    expect(result.map((c) => c.id)).toEqual([1]);
  });

  it('no id found: no second query', async () => {
    const { strapi, findMany } = stub([], []);
    expect(await findNifMatches(strapi, 'B12345678', null)).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('does not query for a short NIF', async () => {
    const { strapi, whereRaw } = stub([], []);
    expect(await findNifMatches(strapi, '12', null)).toEqual([]);
    expect(whereRaw).not.toHaveBeenCalled();
  });
});

// 2026-10-30 review: the first version narrowed by `nif LIKE %<last 4 of the
// key>%`, so a NIF stored as "B-12.345.678" or "12345678 Z" was never found.
// Against a real MySQL (READ_CACHE_TEST_MYSQL, skipped without it).
const URL_ENV = process.env.READ_CACHE_TEST_MYSQL;
(URL_ENV ? describe : describe.skip)('findNifMatches on MySQL', () => {
  const database = `nif_matches_${process.pid}`;
  let admin;
  let knex;

  beforeAll(async () => {
    const url = new URL(URL_ENV);
    const config = {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
    admin = await require('mysql2/promise').createConnection(config);
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.query(`CREATE DATABASE \`${database}\``);
    knex = require('knex')({ client: 'mysql2', connection: { ...config, database }, pool: { min: 0, max: 2 } });
    await knex.raw('CREATE TABLE contacts (id INT PRIMARY KEY, nif VARCHAR(255))');
    await knex('contacts').insert([
      { id: 1, nif: 'B-12.345.678' },
      { id: 2, nif: 'b12345678' },
      { id: 3, nif: '12345678 Z' },
      { id: 4, nif: 'B12345679' },
      { id: 5, nif: null },
    ]);
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin.end();
    }
  });

  const run = async (nif, excludeId = null) => {
    const strapi = {
      db: {
        connection: (t) => knex(t),
        query: () => ({
          findMany: async (q) => {
            return (await knex('contacts').whereIn('id', q.where.id.$in)).map((c) => ({ ...c, owner: null }));
          },
        }),
      },
    };
    const result = await findNifMatches(strapi, nif, excludeId);
    return { ids: result.map((c) => c.id).sort() };
  };

  it('finds the NIF however it was typed', async () => {
    expect((await run('B12345678')).ids).toEqual([1, 2]);
    expect((await run('b 12-345-678', 2)).ids).toEqual([1]);
    expect((await run('12.345.678-z')).ids).toEqual([3]);
  });

  it('another NIF with the same last digits is not a match', async () => {
    expect((await run('C12345678')).ids).toEqual([]);
  });
});
