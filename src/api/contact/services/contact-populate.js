'use strict';

/**
 * What `GET /api/contacts/basic` has to populate.
 *
 * v3 (Bookshelf) exposed every single-valued relation as an FK column, so the
 * frontend received them without asking. v5 omits an unpopulated relation
 * entirely, and the handler's `populate: { projects: false }` populated
 * nothing at all -- ContactsTable's Sector column rendered "-" on every row.
 *
 * Kept out here so the test can check it against the schema: any single-valued
 * relation added to contact later must be listed, or it silently disappears
 * from this endpoint the same way `sector` did.
 */

// The heavy relation collections this endpoint exists to avoid.
const BASIC_EXCLUDED = ['projects', 'projectes', 'collection_points'];

const BASIC_POPULATE = {
  sector: true,
  legal_form: true,
  owner: true,
  users_permissions_user: true,
  // Not single-valued, but ContactsTable builds its "Tipus" column from
  // `contact_types.map(ct => ct.name)`, and the list is short.
  contact_types: true,
};

module.exports = { BASIC_POPULATE, BASIC_EXCLUDED };
