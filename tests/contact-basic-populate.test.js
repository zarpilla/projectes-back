'use strict';

/**
 * ContactsTable's Sector column rendered "-" for every contact after the v5
 * cutover, although the data had migrated correctly (diligencia: 1089
 * contacts_sector_lnk rows, zero orphans, sector ids identical to v3).
 *
 * The table reads `GET /api/contacts/basic`, whose handler passed
 * `populate: { projects: false }`. v3 exposed every single-valued relation as
 * an FK column so the frontend got them for free; v5 omits an unpopulated
 * relation entirely, and that populate object grants nothing. Scalars still
 * rendered (Població is a plain column, which is why it looked selective).
 *
 * The check is schema-driven: a single-valued relation added to contact later
 * has to be listed, or it disappears from this endpoint exactly as sector did.
 */

const fs = require('fs');
const path = require('path');

const { BASIC_POPULATE, BASIC_EXCLUDED } = require('../src/api/contact/services/contact-populate');

const schema = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api', 'contact', 'content-types', 'contact', 'schema.json'),
    'utf8'
  )
);

const relations = Object.entries(schema.attributes).filter(([, a]) => a.type === 'relation');
const singleValued = relations
  .filter(([, a]) => a.relation === 'oneToOne' || a.relation === 'manyToOne')
  .map(([name]) => name);

describe('contacts/basic populate', () => {
  it('finds the single-valued relations in the schema', () => {
    // guards the test itself: if this ever empties, the assertions below pass vacuously
    expect(singleValued.length).toBeGreaterThan(0);
    expect(singleValued).toContain('sector');
  });

  it.each(singleValued)('populates %s — v3 returned it as an FK column', (name) => {
    expect(BASIC_POPULATE[name]).toBe(true);
  });

  it('populates contact_types, which the Tipus column maps over', () => {
    expect(BASIC_POPULATE.contact_types).toBe(true);
  });

  it('leaves the heavy collections alone', () => {
    for (const name of BASIC_EXCLUDED) {
      expect(BASIC_POPULATE[name]).toBeUndefined();
    }
  });

  it('lists nothing that is not an attribute of contact', () => {
    for (const name of Object.keys(BASIC_POPULATE)) {
      expect(Object.keys(schema.attributes)).toContain(name);
    }
  });

  it('is what the handler actually passes', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'api', 'contact', 'controllers', 'contact.js'),
      'utf8'
    );
    expect(source).toContain('populate: BASIC_POPULATE,');
    expect(source).not.toContain('populate: { projects: false }');
  });
});
