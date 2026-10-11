'use strict';

/**
 * Startup script that seeds a brand-new database (catalogs, settings record,
 * home menu, current year, optional first user), so a new instance no longer
 * starts from a restore of the empty `buida` tenant.
 *
 * Guards: an existing tenant's database is never touched, and the first user
 * is only created when its e-mail and password come from the environment.
 */

const ME = 'api::me.me';
const USER = 'plugin::users-permissions.user';
const YEAR = 'api::year.year';

let counts;
let created;
let transactions;
let seedNewDatabase;

const rowsOf = (uid) => created.filter((c) => c.uid === uid).map((c) => c.data);

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers().setSystemTime(new Date('2026-10-11T10:00:00Z'));
  delete process.env.SEED_USER_EMAIL;
  delete process.env.SEED_USER_PASSWORD;
  delete process.env.SEED_USER_NAME;

  counts = {};
  created = [];
  transactions = 0;
  let nextId = 1;
  global.strapi = {
    log: { info: jest.fn() },
    config: { get: () => 'https://demo.example.org' },
    db: {
      query: (uid) => ({
        count: async () => counts[uid] || 0,
        findOne: async () => ({ id: 7, type: 'authenticated' }),
      }),
      transaction: async (callback) => {
        transactions += 1;
        return callback();
      },
    },
    documents: (uid) => ({
      create: async ({ data }) => {
        created.push({ uid, data });
        return { id: nextId++, ...data };
      },
    }),
  };
  ({ seedNewDatabase } = require('../src/services/seed-new-database'));
});

afterEach(() => {
  jest.useRealTimers();
  delete global.strapi;
});

describe('seedNewDatabase', () => {
  it.each([ME, USER, YEAR])('does nothing when the database already has %s rows', async (uid) => {
    counts[uid] = 1;
    await seedNewDatabase();
    expect(created).toEqual([]);
    expect(transactions).toBe(0);
  });

  it('seeds catalogs, settings and home menu in one transaction', async () => {
    await seedNewDatabase();

    expect(transactions).toBe(1);
    expect(rowsOf('api::month.month')).toHaveLength(12);
    expect(rowsOf('api::month.month')[2]).toEqual({ month: 3, name: 'Març', month_number: '03' });
    expect(rowsOf('api::project-state.project-state').map((r) => r.name)).toEqual([
      'Actiu',
      'Tancat',
      'Sol·licitat',
    ]);
    expect(rowsOf('api::vat-type.vat-type').map((r) => r.value)).toEqual([0, 4, 10, 21]);

    const [me] = rowsOf(ME);
    expect(me.options.treasury).toBe(true);
    expect(me.front_url).toBe('https://demo.example.org/stats/#/');
    expect(rowsOf('api::config.config')).toEqual([{ front_url: 'https://demo.example.org/stats/#/' }]);
    expect(rowsOf('api::home-menu.home-menu')[0].homegroup.map((g) => g.name)).toEqual([
      'Projectes',
      'Administració',
      'Ingressos i Despeses',
    ]);
  });

  it('creates the current year, its invoice series and the holidays from that year on', async () => {
    await seedNewDatabase();

    expect(rowsOf(YEAR)).toEqual([{ year: 2026, working_hours: 1760, deductible_vat_pct: 100 }]);
    expect(rowsOf('api::serie.serie')).toEqual([
      { name: '2026', leadingZeros: 3, emitted_invoice_number: 0 },
    ]);

    // Each holiday points at the id of the festive type created just before.
    const types = created.filter((c) => c.uid === 'api::festive-type.festive-type');
    const typeId = (name) => created.indexOf(types.find((t) => t.data.name === name)) + 1;
    const festives = rowsOf('api::festive.festive');
    expect(festives).toHaveLength(12);
    expect(festives).toContainEqual({ date: '2026-09-11', festive_type: typeId('Festiu Catalunya') });
    expect(festives).toContainEqual({ date: '2026-12-25', festive_type: typeId('Festiu Estatal') });
  });

  it('skips holidays of past years', async () => {
    jest.setSystemTime(new Date('2027-01-15T10:00:00Z'));
    await seedNewDatabase();
    expect(rowsOf('api::festive.festive')).toEqual([]);
    expect(rowsOf(YEAR)[0].year).toBe(2027);
  });

  it('creates no user without SEED_USER_EMAIL and SEED_USER_PASSWORD', async () => {
    process.env.SEED_USER_EMAIL = 'someone@example.org';
    await seedNewDatabase();
    expect(rowsOf(USER)).toEqual([]);
  });

  it('creates the first user as an app admin when the credentials are set', async () => {
    process.env.SEED_USER_EMAIL = 'Someone@Example.org';
    process.env.SEED_USER_PASSWORD = 'a-password';
    await seedNewDatabase();

    expect(rowsOf(USER)).toEqual([
      {
        username: 'Someone@Example.org',
        email: 'someone@example.org',
        password: 'a-password',
        provider: 'local',
        confirmed: true,
        blocked: false,
        role: 7,
        permissions: [{ permission: 'projects' }, { permission: 'hours' }, { permission: 'admin' }],
      },
    ]);
  });
});
