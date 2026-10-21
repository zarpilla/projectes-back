'use strict';

/**
 * issues/310: the official Catalan holidays of 2027 for every tenant.
 *
 * Holidays for everyone (no person) are rows in `festives`. The official list
 * of each year lives in the new-database seed list; the run-once startup
 * script addOfficialFestives(year) adds that year's dates to an existing
 * tenant on its next deploy. A date the tenant already has as a holiday for
 * everyone is left alone, so nothing is doubled.
 *
 * Hores anuals compares each type's days with its maximum (Festiu Estatal 8,
 * Festiu Catalunya 4). 2027 has 9 and 3: without a maximum for the year,
 * everyone's summary read «1 dia per sobre del màxim» and took a Catalan
 * holiday as still to come. The script sets the year's maximums, as was done
 * by hand for 2024, creating the year when it is missing.
 */

const FESTIVE = 'api::festive.festive';
const FESTIVE_TYPE = 'api::festive-type.festive-type';
const USER_FESTIVE = 'api::user-festive.user-festive';
const YEAR = 'api::year.year';

const ESTATAL = { id: 1, name: 'Festiu Estatal', personal: false, max: 8 };
const CATALUNYA = { id: 2, name: 'Festiu Catalunya', personal: false, max: 4 };
const TYPES = [
  ESTATAL,
  CATALUNYA,
  { id: 3, name: 'Festiu Local', personal: true, max: 2 },
  { id: 4, name: 'Vacances', personal: true, max: 23 },
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

let db;
let created;
let addOfficialFestives;

const createdOf = (uid) => created.filter((c) => c.uid === uid).map((c) => c.data);
const holidaysCreated = () => createdOf(FESTIVE);
const createdOn = (date) => holidaysCreated().find((c) => c.date === date);
const holiday = (id, date, typeId, userId) => ({
  id,
  date,
  festive_type: typeId ? { id: typeId } : null,
  users_permissions_user: userId ? { id: userId } : null,
});

beforeEach(() => {
  jest.resetModules();
  db = {
    [FESTIVE_TYPE]: TYPES,
    [FESTIVE]: [],
    [USER_FESTIVE]: [],
    [YEAR]: [
      { id: 7, year: 2025, working_hours: 1750, deductible_vat_pct: 100 },
      { id: 8, year: 2026, working_hours: 1720, deductible_vat_pct: 90 },
    ],
  };
  created = [];
  let nextId = 1000;
  global.strapi = {
    log: { info: jest.fn(), warn: jest.fn() },
    db: { query: (uid) => ({ findMany: jest.fn(async () => db[uid] || []) }) },
    documents: (uid) => ({
      create: jest.fn(async ({ data }) => {
        const id = ++nextId;
        created.push({ uid, data });
        // what the next read of the table sees
        if (uid === FESTIVE) db[FESTIVE] = [...db[FESTIVE], holiday(id, data.date, data.festive_type)];
        if (uid === YEAR) db[YEAR] = [...db[YEAR], { id, ...data }];
        if (uid === USER_FESTIVE) {
          db[USER_FESTIVE] = [
            ...db[USER_FESTIVE],
            { id, max: data.max, festive_type: { id: data.festive_type }, year: db[YEAR].find((y) => y.id === data.year), users_permissions_user: null },
          ];
        }
        return { id, ...data };
      }),
    }),
  };
  ({ addOfficialFestives } = require('../src/services/add-official-festives'));
});

afterEach(() => {
  delete global.strapi;
});

describe('addOfficialFestives: the holidays (issues/310)', () => {
  it('adds the twelve official holidays of 2027 for everyone', async () => {
    await addOfficialFestives(2027);

    expect(holidaysCreated().map((c) => c.date).sort()).toEqual(OFFICIAL_2027);
    // none of them belongs to a person
    expect(holidaysCreated().every((c) => c.users_permissions_user === undefined)).toBe(true);
  });

  it('types them as in earlier years: Easter Monday, Sant Joan and the Diada are Catalan, the rest state', async () => {
    await addOfficialFestives(2027);

    const catalan = holidaysCreated().filter((c) => c.festive_type === 2).map((c) => c.date);
    const state = holidaysCreated().filter((c) => c.festive_type === 1).map((c) => c.date);
    expect(catalan).toEqual(['2027-03-29', '2027-06-24', '2027-09-11']);
    expect(state).toHaveLength(9);
    expect(createdOn('2027-11-01').festive_type).toBe(1);
    expect(createdOn('2027-12-06').festive_type).toBe(1);
  });

  it('leaves the dates a tenant already has as a holiday for everyone', async () => {
    db[FESTIVE] = [holiday(1, '2027-01-01', 1), holiday(2, '2027-12-25', 1)];

    const { added } = await addOfficialFestives(2027);

    expect(added).not.toContain('2027-01-01');
    expect(added).not.toContain('2027-12-25');
    expect(added).toHaveLength(10);
  });

  it('still adds a date that is only some person’s day off', async () => {
    db[FESTIVE] = [holiday(1, '2027-06-24', 4, 5)];

    await addOfficialFestives(2027);

    expect(createdOn('2027-06-24')).toEqual({ date: '2027-06-24', festive_type: 2 });
  });

  it('adds nothing the second time', async () => {
    await addOfficialFestives(2027);
    created = [];

    expect(await addOfficialFestives(2027)).toEqual({ added: [], maximums: [] });
    expect(created).toEqual([]);
  });

  it('only adds the year asked for', async () => {
    await addOfficialFestives(2027);
    expect(holidaysCreated().every((c) => c.date.startsWith('2027-'))).toBe(true);
  });

  it('uses another holiday type for everyone when a tenant renamed the official one', async () => {
    db[FESTIVE_TYPE] = [
      { id: 7, name: 'Festius oficials', personal: false, max: 12 },
      { id: 4, name: 'Vacances', personal: true, max: 23 },
    ];

    const { maximums } = await addOfficialFestives(2027);

    expect(holidaysCreated()).toHaveLength(12);
    expect(holidaysCreated().every((c) => c.festive_type === 7)).toBe(true);
    // 12 of 12: no maximum of its own
    expect(maximums).toEqual([]);
  });

  it('adds nothing, with a warning, when the tenant has no holiday type for everyone', async () => {
    db[FESTIVE_TYPE] = [{ id: 4, name: 'Vacances', personal: true, max: 23 }];

    expect(await addOfficialFestives(2027)).toEqual({ added: [], maximums: [] });
    expect(created).toEqual([]);
    expect(global.strapi.log.warn).toHaveBeenCalled();
  });
});

describe('addOfficialFestives: the maximums of the year (issues/310)', () => {
  it('sets Festiu Estatal 9 and Festiu Catalunya 3 for 2027, with no person', async () => {
    db[YEAR] = [...db[YEAR], { id: 9, year: 2027, working_hours: 1720, deductible_vat_pct: 90 }];

    const { maximums } = await addOfficialFestives(2027);

    expect(maximums).toEqual([
      { type: 'Festiu Estatal', max: 9 },
      { type: 'Festiu Catalunya', max: 3 },
    ]);
    expect(createdOf(USER_FESTIVE)).toEqual([
      { festive_type: 1, year: 9, max: 9 },
      { festive_type: 2, year: 9, max: 3 },
    ]);
    expect(createdOf(YEAR)).toEqual([]);
  });

  it('creates a missing 2027 with the hours and VAT of 2026', async () => {
    await addOfficialFestives(2027);

    expect(createdOf(YEAR)).toEqual([{ year: 2027, working_hours: 1720, deductible_vat_pct: 90 }]);
    const yearId = db[YEAR].find((y) => y.year === 2027).id;
    expect(createdOf(USER_FESTIVE).every((uf) => uf.year === yearId)).toBe(true);
  });

  it('counts what the tenant has: a date entered by hand with another type', async () => {
    // 1 January typed as a Catalan holiday: 8 state + 4 Catalan, as the types say
    db[FESTIVE] = [holiday(1, '2027-01-01', 2)];

    const { maximums } = await addOfficialFestives(2027);

    expect(maximums).toEqual([]);
    expect(createdOf(USER_FESTIVE)).toEqual([]);
    expect(createdOf(YEAR)).toEqual([]);
  });

  it('keeps a maximum already set for the year', async () => {
    db[YEAR] = [...db[YEAR], { id: 9, year: 2027 }];
    db[USER_FESTIVE] = [
      { id: 50, max: 10, festive_type: { id: 1 }, year: { id: 9, year: 2027 }, users_permissions_user: null },
      // a person's own maximum is not the year's
      { id: 51, max: 5, festive_type: { id: 2 }, year: { id: 9, year: 2027 }, users_permissions_user: { id: 3 } },
    ];

    const { maximums } = await addOfficialFestives(2027);

    expect(maximums).toEqual([{ type: 'Festiu Catalunya', max: 3 }]);
    expect(createdOf(USER_FESTIVE)).toEqual([{ festive_type: 2, year: 9, max: 3 }]);
  });

  it('uses the defaults for a missing year when there is no earlier one', async () => {
    db[YEAR] = [];

    await addOfficialFestives(2027);

    expect(createdOf(YEAR)).toEqual([{ year: 2027, working_hours: 1760, deductible_vat_pct: 100 }]);
  });
});
