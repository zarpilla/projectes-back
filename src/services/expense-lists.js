'use strict';
/* global strapi */

/**
 * The lists of Despeses (ReceivedInvoicesTable): received invoices, received
 * expenses and payrolls of a period (issues/325).
 *
 * They read the core find with populate=*: every relation of every document
 * (projects, bank account, series, payment method, attachments, whole
 * contacts) and Strapi's REST cleaning of each field, 0.3–0.9 s for a year of
 * resilience locally, up to 19 s on the VPS, while every other request of the
 * tenant waited. These read only what the screen shows and exports, with the
 * same filters (the query adapter), and keep the rows in the read cache
 * (issues/307) until one of the tables they were read from changes.
 *
 * The projects (and a payroll's person) are added on every request, by the
 * same populate query the core find runs for those rows: hours logged mark
 * projects dirty and the totals cron rewrites them all day, which would drop
 * the kept rows for nothing; and the order of a document's projects (the
 * screen shows the first) is the one that query gives, as before.
 *
 * No role scope: only the full-access permissions (projects, admin) reach
 * these actions (app-access-rules has no rule for them), as for the core find.
 */
const { adaptQuery, dbLimit, wantsNoRows } = require('./query-adapter');
const { getReadCache } = require('./read-cache');
const { canonicalJson } = require('./read-cache/read-cache');
const { queryTables } = require('./query-tables');

const RECEIVED_INVOICE = 'api::received-invoice.received-invoice';
const RECEIVED_EXPENSE = 'api::received-expense.received-expense';
const PAYROLL = 'api::payroll.payroll';

// the Contacte column and the export's supplier columns
const CONTACT = { select: ['id', 'name', 'nif', 'address', 'postcode', 'city'] };
const PROJECTS = {
  projects: { select: ['id', 'name'] },
  project: { select: ['id', 'name'] },
};

/**
 * Per list: what is populated in the kept rows (`cached`), and what is added
 * on every request (`live`). Only what the screen and its export read.
 */
const LISTS = {
  [RECEIVED_INVOICE]: {
    cached: { contact: CONTACT, lines: true, contact_info: true },
    live: PROJECTS,
  },
  [RECEIVED_EXPENSE]: {
    cached: {
      contact: CONTACT,
      document_type: { select: ['id', 'name'] },
      lines: true,
      contact_info: true,
    },
    live: PROJECTS,
  },
  [PAYROLL]: {
    cached: { year: { select: ['id', 'year'] }, month: { select: ['id', 'month'] } },
    live: { users_permissions_user: { select: ['id', 'username', 'fullname'] } },
  },
};

async function loadRows(uid, query) {
  const opts = adaptQuery(query);
  if (wantsNoRows(opts)) return [];
  return strapi.db.query(uid).findMany({
    where: opts.filters || {},
    populate: LISTS[uid].cached,
    limit: dbLimit(opts),
    offset: opts.pagination?.start,
    // by id unless asked otherwise, as the core find answers (with a filter
    // on a relation too, where MySQL's own order differs)
    orderBy: opts.sort && opts.sort.length ? opts.sort : [{ id: 'asc' }],
  });
}

/** The `live` relations of `rows`, set in place (they are the caller's copy). */
async function addLive(uid, rows) {
  if (!rows.length) return rows;
  const { live } = LISTS[uid];
  const found = await strapi.db.query(uid).findMany({
    where: { id: { $in: rows.map((r) => r.id) } },
    select: ['id'],
    populate: live,
  });
  const byId = new Map(found.map((r) => [r.id, r]));
  for (const row of rows) {
    const fresh = byId.get(row.id) || {};
    for (const name of Object.keys(live)) row[name] = fresh[name] === undefined ? null : fresh[name];
  }
  return rows;
}

const tablesOf = new Map();

/**
 * The list of `uid` for a v3-style query (the screen's filters): the rows from
 * the read cache when none of their tables changed since they were read, and
 * their projects (or person) read now.
 */
async function expenseList(uid, query) {
  if (!LISTS[uid]) throw new Error(`no expense list for ${uid}`);
  if (!tablesOf.has(uid)) tablesOf.set(uid, [...queryTables(strapi, uid, LISTS[uid].cached)]);
  const rows = await getReadCache().get(
    `expense-list:${uid}:${canonicalJson(query || {})}`,
    () => loadRows(uid, query),
    { tables: tablesOf.get(uid) },
  );
  return addLive(uid, rows);
}

module.exports = { expenseList, LISTS, RECEIVED_INVOICE, RECEIVED_EXPENSE, PAYROLL };
