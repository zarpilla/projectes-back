'use strict';

/**
 * issues/232 — every project save linked its periodification / grant rows once
 * more with component_type NULL (see project-update-component-refs.test.js).
 * The run-once repair drops those copies (or types the only link of a live
 * row) and never touches a typed link. The Arran de Terra production dump of
 * 2026-10-16 had four of them on project 263 (two saves).
 */

const fs = require('fs');
const path = require('path');

let tables;

// enough knex for the script: where / whereNull / whereNotNull / whereIn, select, del, update
function fakeConnection(name) {
  const filters = [];
  const rows = () => tables[name].filter((r) => filters.every((f) => f(r)));
  const builder = {
    where: (col, value) => (filters.push((r) => r[col] === value), builder),
    whereNull: (col) => (filters.push((r) => r[col] === null), builder),
    whereNotNull: (col) => (filters.push((r) => r[col] !== null), builder),
    whereIn: (col, values) => (filters.push((r) => values.includes(r[col])), builder),
    select: async (...cols) => rows().map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))),
    del: async () => {
      const gone = rows();
      tables[name] = tables[name].filter((r) => !gone.includes(r));
      return gone.length;
    },
    update: async (values) => {
      const hit = rows();
      hit.forEach((r) => Object.assign(r, values));
      return hit.length;
    },
  };
  return builder;
}

const P = 'periodification.periodification';
const G = 'grantable.grantable-year';

beforeEach(() => {
  jest.resetModules();
  tables = {
    projects_cmps: [
      // project 263 after two saves: the typed links and two untyped copies of each
      { id: 1, entity_id: 263, cmp_id: 24, component_type: P, field: 'periodification' },
      { id: 2, entity_id: 263, cmp_id: 25, component_type: P, field: 'periodification' },
      { id: 366, entity_id: 263, cmp_id: 24, component_type: null, field: 'periodification' },
      { id: 367, entity_id: 263, cmp_id: 25, component_type: null, field: 'periodification' },
      { id: 368, entity_id: 263, cmp_id: 24, component_type: null, field: 'periodification' },
      { id: 369, entity_id: 263, cmp_id: 25, component_type: null, field: 'periodification' },
      // a grant year only linked untyped: kept, typed
      { id: 400, entity_id: 7, cmp_id: 5, component_type: null, field: 'grantable_years' },
      // an untyped link to a row deleted since: removed
      { id: 401, entity_id: 7, cmp_id: 99, component_type: null, field: 'periodification' },
      // another project, untouched
      { id: 3, entity_id: 8, cmp_id: 30, component_type: P, field: 'periodification' },
      // phases (not a component field of the project content type now): left alone
      { id: 4, entity_id: 8, cmp_id: 1, component_type: null, field: 'phases' },
    ],
    components_periodification_periodifications: [{ id: 24 }, { id: 25 }, { id: 30 }],
    components_grantable_grantable_years: [{ id: 5 }],
  };
  global.strapi = {
    log: { info: jest.fn() },
    contentType: () => ({
      attributes: {
        name: { type: 'string' },
        periodification: { type: 'component', repeatable: true, component: P },
        grantable_years: { type: 'component', repeatable: true, component: G },
      },
    }),
    db: {
      metadata: {
        get: (uid) =>
          ({
            'api::project.project': {
              tableName: 'projects',
              attributes: {
                periodification: { joinTable: { name: 'projects_cmps' } },
                grantable_years: { joinTable: { name: 'projects_cmps' } },
              },
            },
            [P]: { tableName: 'components_periodification_periodifications' },
            [G]: { tableName: 'components_grantable_grantable_years' },
          })[uid],
      },
      connection: fakeConnection,
    },
  };
});

afterEach(() => {
  delete global.strapi;
});

describe('removeUntypedProjectComponentLinks (issues/232)', () => {
  it('removes the untyped copies, types the only link of a live row, leaves the rest', async () => {
    const { removeUntypedProjectComponentLinks } = require('../src/services/remove-untyped-project-component-links');
    await removeUntypedProjectComponentLinks();
    const links = tables.projects_cmps.map((l) => [l.id, l.component_type]);
    expect(links).toEqual([
      [1, P],
      [2, P],
      [400, G],
      [3, P],
      [4, null],
    ]);
  });

  it('is idempotent', async () => {
    const { removeUntypedProjectComponentLinks } = require('../src/services/remove-untyped-project-component-links');
    await removeUntypedProjectComponentLinks();
    const after = JSON.stringify(tables.projects_cmps);
    const second = await removeUntypedProjectComponentLinks();
    expect(JSON.stringify(tables.projects_cmps)).toBe(after);
    expect(second).toEqual({ removed: [], typed: [] });
  });

  it('is registered as a run-once startup script', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    expect(index).toContain(
      "['removeUntypedProjectComponentLinks', removeUntypedProjectComponentLinks, { runOnce: true }]",
    );
  });
});
