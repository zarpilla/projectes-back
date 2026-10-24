'use strict';

/**
 * issues/334 (2026-10-24): a document linked to several projects showed one
 * first project now and another after a reload, in Ingressos and Despeses and
 * their exports. Strapi lists a relation by the link table's order column
 * (project_ord), and the links migrated from v3 have it empty: MySQL gave the
 * ties in any order. The startup script fillEmptyRelationOrder numbers them in
 * the order they were made (the link row's id), as the user decided.
 *
 * The MySQL part needs READ_CACHE_TEST_MYSQL=mysql://user:password@host:port
 * (creates and drops a database relation_order_<pid>). Skipped without it.
 */

const { orderColumns, fillRelationOrder } = require('../src/services/relation-order');

const metadata = new Map([
  [
    'api::emitted-invoice.emitted-invoice',
    {
      attributes: {
        projects: {
          type: 'relation',
          relation: 'manyToMany',
          joinTable: {
            name: 'emitted_invoices_projects_lnk',
            joinColumn: { name: 'emitted_invoice_id' },
            inverseJoinColumn: { name: 'project_id' },
            orderColumnName: 'project_ord',
            inverseOrderColumnName: 'emitted_invoice_ord',
          },
        },
        contact: {
          type: 'relation',
          relation: 'manyToOne',
          joinTable: {
            name: 'emitted_invoices_contact_lnk',
            joinColumn: { name: 'emitted_invoice_id' },
            inverseJoinColumn: { name: 'contact_id' },
            inverseOrderColumnName: 'emitted_invoice_ord',
          },
        },
        lines: {
          type: 'relation',
          relation: 'oneToMany',
          joinTable: {
            name: 'emitted_invoices_cmps',
            joinColumn: { name: 'entity_id' },
            inverseJoinColumn: { name: 'cmp_id' },
            orderColumnName: 'order',
            on: { field: 'lines' },
          },
        },
        attachments: { type: 'relation', relation: 'morphMany', joinTable: { name: 'files_related_mph', orderColumnName: 'order' } },
        name: { type: 'string' },
      },
    },
  ],
  [
    'api::project.project',
    {
      attributes: {
        // the inverse side names the same table and columns again
        emitted_invoices: {
          type: 'relation',
          relation: 'manyToMany',
          joinTable: {
            name: 'emitted_invoices_projects_lnk',
            joinColumn: { name: 'project_id' },
            inverseJoinColumn: { name: 'emitted_invoice_id' },
            orderColumnName: 'emitted_invoice_ord',
            inverseOrderColumnName: 'project_ord',
          },
        },
      },
    },
  ],
]);

describe('orderColumns (issues/334)', () => {
  it('lists each order column of the link tables once, with the column that groups it', () => {
    expect(orderColumns(metadata)).toEqual([
      { table: 'emitted_invoices_contact_lnk', column: 'emitted_invoice_ord', groupBy: 'contact_id' },
      { table: 'emitted_invoices_projects_lnk', column: 'emitted_invoice_ord', groupBy: 'project_id' },
      { table: 'emitted_invoices_projects_lnk', column: 'project_ord', groupBy: 'emitted_invoice_id' },
    ]);
  });
});

const URL_ENV = process.env.READ_CACHE_TEST_MYSQL;
const describeDb = URL_ENV ? describe : describe.skip;

jest.setTimeout(60 * 1000);

describeDb('fillRelationOrder on MySQL (issues/334)', () => {
  let admin;
  let knex;
  const database = `relation_order_${process.pid}`;

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
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin.end();
    }
  });

  const ordered = async (column, groupBy, id) =>
    (await knex('emitted_invoices_projects_lnk').where(groupBy, id).orderBy([column, 'id']).select('id', column)).map(
      (r) => [r.id, r[column]],
    );

  beforeEach(async () => {
    await knex.raw('DROP TABLE IF EXISTS emitted_invoices_projects_lnk');
    await knex.raw(`CREATE TABLE emitted_invoices_projects_lnk (id INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
      emitted_invoice_id INT UNSIGNED, project_id INT UNSIGNED, project_ord DOUBLE UNSIGNED, emitted_invoice_ord DOUBLE UNSIGNED)`);
    await knex('emitted_invoices_projects_lnk').insert([
      // invoice 533 (resilience): two projects from v3, no order
      { id: 10, emitted_invoice_id: 533, project_id: 235, project_ord: null, emitted_invoice_ord: null },
      { id: 4, emitted_invoice_id: 533, project_id: 220, project_ord: null, emitted_invoice_ord: null },
      // invoice 7, made in v5: ordered, the order kept although the ids say otherwise
      { id: 20, emitted_invoice_id: 7, project_id: 220, project_ord: 1, emitted_invoice_ord: 1 },
      { id: 15, emitted_invoice_id: 7, project_id: 235, project_ord: 2, emitted_invoice_ord: 1 },
      // invoice 8: a v3 link and one added in v5 after it
      { id: 30, emitted_invoice_id: 8, project_id: 300, project_ord: 1, emitted_invoice_ord: null },
      { id: 25, emitted_invoice_id: 8, project_id: 301, project_ord: null, emitted_invoice_ord: null },
      // a link without its document
      { id: 40, emitted_invoice_id: null, project_id: 300, project_ord: null, emitted_invoice_ord: null },
    ]);
  });

  const columns = [
    { table: 'emitted_invoices_projects_lnk', column: 'project_ord', groupBy: 'emitted_invoice_id' },
    { table: 'emitted_invoices_projects_lnk', column: 'emitted_invoice_ord', groupBy: 'project_id' },
    { table: 'not_there_lnk', column: 'x_ord', groupBy: 'y_id' },
  ];

  it("numbers a document's projects in the order they were linked", async () => {
    await fillRelationOrder(knex, columns);
    expect(await ordered('project_ord', 'emitted_invoice_id', 533)).toEqual([[4, 1], [10, 2]]);
  });

  it('keeps an order already set; empty ones first, as MySQL listed them', async () => {
    await fillRelationOrder(knex, columns);
    expect(await ordered('project_ord', 'emitted_invoice_id', 7)).toEqual([[20, 1], [15, 2]]);
    expect(await ordered('project_ord', 'emitted_invoice_id', 8)).toEqual([[25, 1], [30, 2]]);
  });

  it('fills the inverse side too, leaves links without an owner alone, and a rerun changes nothing', async () => {
    const changed = await fillRelationOrder(knex, columns);
    expect(Object.keys(changed).sort()).toEqual([
      'emitted_invoices_projects_lnk.emitted_invoice_ord',
      'emitted_invoices_projects_lnk.project_ord',
    ]);
    const empty = await knex('emitted_invoices_projects_lnk').whereNull('project_ord').orWhereNull('emitted_invoice_ord').pluck('id');
    expect(empty).toEqual([40]);
    expect(await fillRelationOrder(knex, columns)).toEqual({});
  });
});
