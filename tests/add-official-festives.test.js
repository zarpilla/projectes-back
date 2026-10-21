'use strict';

/**
 * issues/310: the official Catalan holidays of 2027 for every tenant.
 *
 * Holidays for everyone (no person) are rows in `festives`. The official list
 * of each year lives in the new-database seed list; the run-once startup
 * script addOfficialFestives(year) adds that year's dates to an existing
 * tenant on its next deploy. A date the tenant already has as a holiday for
 * everyone is left alone, so nothing is doubled.
 */

const FESTIVE = 'api::festive.festive';
const FESTIVE_TYPE = 'api::festive-type.festive-type';

const TYPES = [
  { id: 1, name: 'Festiu Estatal', personal: false },
  { id: 2, name: 'Festiu Catalunya', personal: false },
  { id: 3, name: 'Festiu Local', personal: true },
  { id: 4, name: 'Vacances', personal: true },
];

const OFFICIAL_2027 = [
  '2027-01-01',
  '2027-01-06',
  '2027-03-26',
  '2027-03-29',
  '2027-05-01',
  '2027-06-24',
  '2027-09-11',
  '2027-10-12',
  '2027-11-01',
  '2027-12-06',
  '2027-12-08',
  '2027-12-25',
];

let types;
let festives;
let created;
let addOfficialFestives;

const createdOn = (date) => created.find((c) => c.date === date);

beforeEach(() => {
  jest.resetModules();
  types = TYPES;
  festives = [];
  created = [];
  global.strapi = {
    log: { info: jest.fn(), warn: jest.fn() },
    db: {
      query: (uid) => ({
        findMany: jest.fn(async () => (uid === FESTIVE_TYPE ? types : uid === FESTIVE ? festives : [])),
      }),
    },
    documents: (uid) => ({
      create: jest.fn(async ({ data }) => {
        expect(uid).toBe(FESTIVE);
        created.push(data);
        return { id: 100 + created.length, ...data };
      }),
    }),
  };
  ({ addOfficialFestives } = require('../src/services/add-official-festives'));
});

afterEach(() => {
  delete global.strapi;
});

describe('addOfficialFestives (issues/310)', () => {
  it('adds the twelve official holidays of 2027 for everyone', async () => {
    await addOfficialFestives(2027);

    expect(created.map((c) => c.date).sort()).toEqual(OFFICIAL_2027);
    // none of them belongs to a person
    expect(created.every((c) => c.users_permissions_user === undefined)).toBe(true);
  });

  it('types them as in earlier years: Easter Monday, Sant Joan and the Diada are Catalan, the rest state', async () => {
    await addOfficialFestives(2027);

    const catalan = created.filter((c) => c.festive_type === 2).map((c) => c.date);
    const state = created.filter((c) => c.festive_type === 1).map((c) => c.date);
    expect(catalan).toEqual(['2027-03-29', '2027-06-24', '2027-09-11']);
    expect(state).toHaveLength(9);
    expect(createdOn('2027-11-01').festive_type).toBe(1);
    expect(createdOn('2027-12-06').festive_type).toBe(1);
  });

  it('leaves the dates a tenant already has as a holiday for everyone', async () => {
    festives = [
      { id: 1, date: '2027-01-01', users_permissions_user: null },
      { id: 2, date: '2027-12-25', users_permissions_user: null },
    ];

    const added = await addOfficialFestives(2027);

    expect(created.map((c) => c.date)).not.toContain('2027-01-01');
    expect(created.map((c) => c.date)).not.toContain('2027-12-25');
    expect(added).toHaveLength(10);
  });

  it('still adds a date that is only some person’s day off', async () => {
    festives = [{ id: 1, date: '2027-06-24', users_permissions_user: { id: 5 } }];

    await addOfficialFestives(2027);

    expect(createdOn('2027-06-24')).toEqual({ date: '2027-06-24', festive_type: 2 });
  });

  it('adds nothing the second time', async () => {
    await addOfficialFestives(2027);
    festives = created.map((c, i) => ({ id: i + 1, date: c.date, users_permissions_user: null }));
    created = [];

    expect(await addOfficialFestives(2027)).toEqual([]);
    expect(created).toEqual([]);
  });

  it('only adds the year asked for', async () => {
    await addOfficialFestives(2027);
    expect(created.every((c) => c.date.startsWith('2027-'))).toBe(true);
  });

  it('uses another holiday type for everyone when a tenant renamed the official one', async () => {
    types = [
      { id: 7, name: 'Festius oficials', personal: false },
      { id: 4, name: 'Vacances', personal: true },
    ];

    await addOfficialFestives(2027);

    expect(created).toHaveLength(12);
    expect(created.every((c) => c.festive_type === 7)).toBe(true);
  });

  it('adds nothing, with a warning, when the tenant has no holiday type for everyone', async () => {
    types = [{ id: 4, name: 'Vacances', personal: true }];

    expect(await addOfficialFestives(2027)).toEqual([]);
    expect(created).toEqual([]);
    expect(global.strapi.log.warn).toHaveBeenCalled();
  });
});
