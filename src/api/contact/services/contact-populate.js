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

// What a contact list may say about the users it links to. Populated whole,
// `owner` and `users_permissions_user` put the user's salary, hourly cost,
// identity number and social security number in every row, for any logged-in
// user (a partner placing orders included), and were 28% of the answer
// (issues/016). The front reads only these off a contact's users.
const USER_PUBLIC_FIELDS = ['id', 'documentId', 'username', 'fullname', 'email'];

const BASIC_POPULATE = {
  sector: true,
  legal_form: true,
  owner: { select: USER_PUBLIC_FIELDS },
  users_permissions_user: { select: USER_PUBLIC_FIELDS },
  // Not single-valued, but ContactsTable builds its "Tipus" column from
  // `contact_types.map(ct => ct.name)`, and the list is short.
  contact_types: true,
};

module.exports = { BASIC_POPULATE, BASIC_EXCLUDED, USER_PUBLIC_FIELDS };
