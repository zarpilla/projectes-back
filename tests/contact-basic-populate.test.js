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

const { BASIC_POPULATE, BASIC_EXCLUDED, USER_PUBLIC_FIELDS } = require('../src/api/contact/services/contact-populate');

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
    expect(BASIC_POPULATE[name]).toBeTruthy();
  });

  // issues/016: populated whole, the contact's users carried their salary,
  // hourly cost, identity number and social security number to every logged-in
  // user, in each of the 1,162 rows (28% of a 2 MB answer).
  it.each(['owner', 'users_permissions_user'])('%s carries the public profile only', (name) => {
    expect(BASIC_POPULATE[name]).toEqual({ select: USER_PUBLIC_FIELDS });
    for (const f of ['monthly_salary', 'monthly_tax', 'cost_by_hour', 'identity_number', 'naf', 'ical', 'password']) {
      expect(USER_PUBLIC_FIELDS).not.toContain(f);
    }
    // what the front reads off a contact's users
    for (const f of ['id', 'username', 'fullname', 'email']) {
      expect(USER_PUBLIC_FIELDS).toContain(f);
    }
  });

  it('the public profile fields are scalars of the user (select takes scalars only)', () => {
    const user = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', 'src', 'extensions', 'users-permissions', 'content-types', 'user', 'schema.json'),
        'utf8'
      )
    ).attributes;
    for (const f of USER_PUBLIC_FIELDS.filter((x) => x !== 'id' && x !== 'documentId')) {
      expect(user[f]).toBeDefined();
      expect(['relation', 'component']).not.toContain(user[f].type);
    }
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
