'use strict';

/**
 * issues/328 — the move of the stored totals to project_totals, against a real
 * MySQL (the parts a stub can't prove):
 *   - the migration creates the table, copies every value from the old columns
 *     (rerunnable), keeps those columns in `projects` (the previous backend of
 *     a blue/green deploy still selects them) and takes them out of the schema
 *     Strapi recorded, so its sync doesn't drop them;
 *   - reads give numbers; marking dirty and writing totals are upserts, inside
 *     the transaction in progress too, while it holds the project row;
 *   - deleting a project deletes its totals (foreign key);
 *   - at boot a project without a row gets one, dirty;
 *   - issues/329: a later release drops the old columns from `projects`
 *     (only those still there, rerunnable), totals untouched.
 * Needs READ_CACHE_TEST_MYSQL=mysql://user:password@host:port (creates and
 * drops a database project_totals_<pid>). Skipped without it.
 */

const URL_ENV = process.env.READ_CACHE_TEST_MYSQL;
const describeDb = URL_ENV ? describe : describe.skip;

jest.setTimeout(60 * 1000);

describeDb('project_totals on MySQL (issues/328)', () => {
  let admin;
  let knex;
  const database = `project_totals_${process.pid}`;

  const storedSchema = () => ({
    tables: [
      {
        name: 'projects',
        columns: ['id', 'name', 'balance', 'total_real_hours', 'total_expenses_vat', 'dirty'].map((name) => ({ name })),
      },
      { name: 'cities', columns: [{ name: 'id' }, { name: 'balance' }] },
    ],
  });

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
    knex = require('knex')({ client: 'mysql2', connection: { ...config, database }, pool: { min: 0, max: 4 } });
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin.end();
    }
  });

  beforeEach(async () => {
    jest.resetModules();
    await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['project_totals', 'projects', 'strapi_database_schema']) await knex.raw(`DROP TABLE IF EXISTS \`${t}\``);
    await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
    await knex.raw(`CREATE TABLE projects (id INT UNSIGNED PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50),
      balance DECIMAL(10,2), total_real_hours DECIMAL(10,2), total_expenses_vat DECIMAL(10,2), dirty TINYINT(1))`);
    await knex('projects').insert([
      { id: 1, name: 'p1', balance: 10.5, total_real_hours: 3, total_expenses_vat: 1, dirty: 0 },
      { id: 2, name: 'p2', balance: null, total_real_hours: 0, total_expenses_vat: null, dirty: 1 },
      { id: 3, name: 'p3', balance: -4, total_real_hours: 7.25, total_expenses_vat: 0, dirty: 0 },
    ]);
    await knex.raw('CREATE TABLE strapi_database_schema (id INT PRIMARY KEY AUTO_INCREMENT, `schema` JSON, time DATETIME, hash VARCHAR(255))');
    await knex('strapi_database_schema').insert({ schema: JSON.stringify(storedSchema()), time: new Date(), hash: 'h' });
    global.strapi = {
      db: {
        connection: knex,
        inTransaction: () => false,
        transaction: (cb) => knex.transaction((trx) => cb({ trx })),
      },
      log: { info: () => {}, warn: () => {} },
    };
  });

  afterEach(() => {
    delete global.strapi;
  });

  const migrate = () => {
    const migration = require('../database/migrations/2026.10.24T00.00.00.project-totals');
    // Strapi runs it inside a transaction
    return knex.transaction((trx) => migration.up(trx));
  };
  const totals = (id) => knex('project_totals').where({ project_id: id }).first();
  const columnsOfProjects = async () =>
    (await knex.raw('SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', ['projects']))[0].map((r) => r.c);

  it('the migration copies every value, keeps the old columns and untracks them, and can run again', async () => {
    await migrate();
    const rows = await knex('project_totals').orderBy('project_id');
    expect(rows.map((r) => [r.project_id, r.balance, r.total_real_hours, r.total_expenses_vat, r.dirty])).toEqual([
      [1, '10.50', '3.00', '1.00', 0],
      [2, null, '0.00', null, 1],
      [3, '-4.00', '7.25', '0.00', 0],
    ]);
    expect(await columnsOfProjects()).toEqual(expect.arrayContaining(['balance', 'dirty', 'total_real_hours']));
    const [{ schema }] = await knex('strapi_database_schema').select('schema');
    const stored = typeof schema === 'string' ? JSON.parse(schema) : schema;
    expect(stored.tables.find((t) => t.name === 'projects').columns.map((c) => c.name)).toEqual(['id', 'name']);
    // another table's column of the same name is not touched
    expect(stored.tables.find((t) => t.name === 'cities').columns.map((c) => c.name)).toEqual(['id', 'balance']);

    await knex('projects').where({ id: 3 }).update({ balance: 8 });
    await migrate();
    expect((await totals(3)).balance).toBe('8.00');
  });

  it('a database without projects yet: the migration does nothing, the boot step creates the table', async () => {
    await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
    await knex.raw('DROP TABLE projects');
    await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
    await migrate();
    expect(await knex.schema.hasTable('project_totals')).toBe(false);
    await knex.raw('CREATE TABLE projects (id INT UNSIGNED PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50))');
    await knex('projects').insert([{ id: 1, name: 'new tenant' }]);
    const result = await require('../src/api/project/services/project-totals').ensureProjectTotals();
    expect(result).toEqual({ created: true, marked: 1 });
    expect((await totals(1)).dirty).toBe(1);
  });

  it('reads as numbers; marks and writes as upserts; inside a transaction holding the project too', async () => {
    await migrate();
    const pt = require('../src/api/project/services/project-totals');
    const projects = [{ id: 1 }, { id: 3 }];
    await pt.attachTotals(projects);
    expect(projects[0]).toMatchObject({ balance: 10.5, total_real_hours: 3, dirty: false });
    expect(projects[1]).toMatchObject({ balance: -4, total_real_hours: 7.25 });

    await pt.writeTotals(1, { balance: 99, total_real_hours: 1 }, { dirty: false });
    expect(await totals(1)).toMatchObject({ balance: '99.00', total_real_hours: '1.00', dirty: 0 });

    // a project PUT: the transaction updates the project, then marks it dirty
    await knex.transaction(async (trx) => {
      global.strapi.db.inTransaction = () => true;
      global.strapi.db.transaction = (cb) => cb({ trx });
      await trx('projects').where({ id: 3 }).update({ name: 'renamed' });
      await pt.markDirty([3]);
    });
    global.strapi.db.inTransaction = () => false;
    expect((await totals(3)).dirty).toBe(1);
    expect((await totals(3)).balance).toBe('-4.00');
    expect(await pt.dirtyIds()).toEqual(expect.arrayContaining([2, 3]));
    expect(await pt.dirtyCount()).toBe(2);
  });

  it('deleting a project deletes its totals', async () => {
    await migrate();
    await knex('projects').where({ id: 2 }).delete();
    expect(await totals(2)).toBeUndefined();
  });

  it('a project inserted without totals gets a dirty row at boot', async () => {
    await migrate();
    await knex('projects').insert({ id: 4, name: 'by hand' });
    const result = await require('../src/api/project/services/project-totals').ensureProjectTotals();
    expect(result).toEqual({ created: false, marked: 1 });
    expect((await totals(4)).dirty).toBe(1);
  });

  const dropOld = () => {
    const migration = require('../database/migrations/2026.10.30T00.00.00.drop-old-project-total-columns');
    return knex.transaction((trx) => migration.up(trx));
  };

  it('issues/329: the later release drops the old columns, keeps the rest of projects and the totals', async () => {
    await migrate();
    await dropOld();
    expect(await columnsOfProjects()).toEqual(['id', 'name']);
    expect((await knex('projects').orderBy('id')).map((r) => [r.id, r.name])).toEqual([[1, 'p1'], [2, 'p2'], [3, 'p3']]);
    const rows = await knex('project_totals').orderBy('project_id');
    expect(rows.map((r) => [r.project_id, r.balance, r.dirty])).toEqual([[1, '10.50', 0], [2, null, 1], [3, '-4.00', 0]]);
    // runs again (or on a tenant that never had them): nothing to do
    await dropOld();
    expect(await columnsOfProjects()).toEqual(['id', 'name']);
  });

  it('issues/329: only the old columns still there are dropped', async () => {
    await knex.raw('ALTER TABLE projects DROP COLUMN balance, DROP COLUMN dirty');
    await dropOld();
    expect(await columnsOfProjects()).toEqual(['id', 'name']);
  });

  it('issues/329: a database without projects yet: nothing to drop', async () => {
    await knex.raw('DROP TABLE projects');
    await expect(dropOld()).resolves.toBeUndefined();
  });
});
