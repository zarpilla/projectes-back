'use strict';

/**
 * "Entrada hores" (ModalBoxDedication) preselects the "Tipus dedicació" radio
 * from `project.default_dedication_type`, and DedicationEstPivot renders it as
 * a column. Both read the project rows served by GET /api/projects/basic.
 *
 * That handler's populate list did not include default_dedication_type, so in
 * v5 the key was absent from every row. The frontend's branches are:
 *
 *   if (project.default_dedication_type && project.default_dedication_type.id)
 *   else if (project.default_dedication_type === null)
 *   else if (project.default_dedication_type)
 *
 * `undefined` matches none of them -- not even the `=== null` one -- so no
 * default was ever applied. v3 kept the relation as an FK column, so the key
 * was always present as an id or null.
 *
 * Verified against the dev database through Strapi: with the relation
 * populated explicitly, project 2 returns default_dedication_type = null and
 * global_activity_types = 7 entries; without it, the key is absent.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const controller = fs.readFileSync(
  path.join(SRC, 'api', 'project', 'controllers', 'project.js'),
  'utf8'
);
const schema = JSON.parse(
  fs.readFileSync(
    path.join(SRC, 'api', 'project', 'content-types', 'project', 'schema.json'),
    'utf8'
  )
);

/** The populate arrays passed to v3FindArgs inside findWithBasicInfo. */
function basicPopulateLists() {
  const start = controller.indexOf('async findWithBasicInfo');
  const end = controller.indexOf('async findNames');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = controller.slice(start, end);
  return body.match(/v3FindArgs\(ctx\.query,\s*\[([\s\S]*?)\]\)/g) || [];
}

describe('projects/basic populate', () => {
  const lists = basicPopulateLists();

  it('has both query branches — guards the extraction', () => {
    // one branch for _q search, one for plain listing
    expect(lists.length).toBe(2);
  });

  it.each([
    'default_dedication_type',
    'global_activity_types',
    'activity_types',
    'mother',
  ])('every branch populates %s', (name) => {
    for (const list of lists) {
      expect(list).toContain(`'${name}'`);
    }
  });

  it('those are real relations on project, not typos', () => {
    for (const name of ['default_dedication_type', 'global_activity_types', 'activity_types', 'mother']) {
      expect(schema.attributes[name]).toBeDefined();
      expect(schema.attributes[name].type).toBe('relation');
    }
  });

  it('the handler does not strip them on the way out', () => {
    const start = controller.indexOf('async findWithBasicInfo');
    const end = controller.indexOf('async findNames');
    const body = controller.slice(start, end);
    // the destructure that drops heavy collections must not name these
    for (const name of ['default_dedication_type', 'global_activity_types']) {
      expect(body).not.toMatch(new RegExp(`^\\s+${name},$`, 'm'));
    }
  });
});
