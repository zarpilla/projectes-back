'use strict';

/**
 * issues/206 — project links to deleted mother projects.
 *
 * The ETL copied v3's `mother` column with the foreign keys off, so resilience's
 * project 388 came over pointing at mother 731, which no longer exists. v5
 * can't leave one behind itself: `projects_mother_lnk` cascades on delete, so
 * deleting a mother drops its children's links. Hence a run-once repair on the
 * link table, and the ETL copying only links whose target exists.
 */

const fs = require('fs');
const path = require('path');

let deleted;
let links;
let projectIds;

beforeEach(() => {
  jest.resetModules();
  deleted = [];
  projectIds = [1, 2, 3, 388];
  links = [
    // valid: untouched
    { id: 1, project_id: 2, inv_project_id: 1 },
    { id: 2, project_id: 3, inv_project_id: 1 },
    // mother deleted in v3
    { id: 6, project_id: 388, inv_project_id: 731 },
    // child missing
    { id: 7, project_id: 999, inv_project_id: 1 },
  ];
  const connection = jest.fn((table) => ({
    select: async () => (table === 'projects' ? projectIds.map((id) => ({ id })) : links),
    whereIn: (column, ids) => ({ del: async () => deleted.push({ table, column, ids }) }),
  }));
  global.strapi = {
    log: { info: jest.fn() },
    db: {
      metadata: {
        get: () => ({
          tableName: 'projects',
          attributes: {
            mother: {
              joinTable: {
                name: 'projects_mother_lnk',
                joinColumn: { name: 'project_id' },
                inverseJoinColumn: { name: 'inv_project_id' },
              },
            },
          },
        }),
      },
      connection,
    },
  };
});

describe('clearDanglingMotherLinks (issues/206)', () => {
  it('removes the links whose mother or child is missing, only those', async () => {
    const { clearDanglingMotherLinks } = require('../src/services/clear-dangling-mother-links');
    await clearDanglingMotherLinks();
    expect(deleted).toEqual([{ table: 'projects_mother_lnk', column: 'id', ids: [6, 7] }]);
  });

  it('does nothing when every link is valid', async () => {
    links = links.slice(0, 2);
    const { clearDanglingMotherLinks } = require('../src/services/clear-dangling-mother-links');
    await clearDanglingMotherLinks();
    expect(deleted).toEqual([]);
  });

  it('is registered as a run-once startup script', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    expect(index).toContain("['clearDanglingMotherLinks', clearDanglingMotherLinks, { runOnce: true }]");
  });
});

describe('ETL inline FK links (issues/206)', () => {
  const source = fs
    .readFileSync(path.join(__dirname, '..', 'tools', 'etl', 'migrate.js'), 'utf8')
    .replace(/\\`/g, '`');

  it('copies only links whose v3 target row exists', () => {
    const inline = source.slice(source.indexOf('} else if (hasInlineFk) {'));
    expect(inline).toContain('const targetIds = `SELECT id FROM `${FROM}`.`${targetTable}``;');
    expect(inline).toContain('AND `${attrName}` IN (${targetIds})');
    expect(inline).toContain('WHERE `${attrName}` > 0${targetExists}`');
  });
});
