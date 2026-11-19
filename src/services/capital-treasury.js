'use strict';
/* global strapi */

/**
 * Capital contributions in Tresoreria (issues/436, resilience-earth).
 *
 * When Configuració › «Aportacions de capital a Tresoreria a partir del» has a
 * date (`me.options.capital_treasury_from`), each contribution of a contact
 * (services/capital-contributions.js) ENTERED in the platform from that date on
 * has a treasury annotation (an «Operació de tresoreria»): concept
 * «Aportació de capital <contact name>», its amount and its date, on the
 * default bank account (treasury lifecycles). The annotation follows the
 * contribution: changed with it, deleted with it (or with the contact).
 *
 * What counts is when the contribution was entered, not its date: a
 * contribution dated before the cut-off but entered after it goes to
 * Tresoreria too (those entered before were already recorded there by hand).
 * Each contribution keeps when it was entered in `entered_at`, stamped by the
 * contact lifecycles when the row is new; the ones that existed before this
 * change have none and never go to Tresoreria.
 *
 * The annotation is linked by `treasuries.contact` and
 * `treasuries.capital_contribution_id` (the contribution's row id, kept by
 * Strapi when the row is sent back with its id). It is edited only from the
 * contact: a sync overwrites what was changed in Tresoreria.
 */

const CONTACT = 'api::contact.contact';
const TREASURY = 'api::treasury.treasury';
const ME = 'api::me.me';

const blank = (value) => value === undefined || value === null || String(value).trim() === '';

const conceptOf = (name) => `Aportació de capital ${String(name || '').trim()}`.trim();

/** The cut-off date ('YYYY-MM-DD') of the options, or null when the sync is off. */
function cutoffOf(options) {
  const from = options && options.capital_treasury_from;
  return blank(from) ? null : String(from).slice(0, 10);
}

async function currentCutoff() {
  const me = await strapi.db.query(ME).findOne({ populate: ['options'] });
  return cutoffOf(me && me.options);
}

const dayOf = (value) => {
  if (blank(value)) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  // the server's local day (Europe/Madrid in production)
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * The annotations a contact's contributions should have:
 * [{ capital_contribution_id, total, date, comment }]. Only rows entered on or
 * after the cut-off, with an amount other than 0. A row without a date takes
 * the day it was entered.
 */
function expectedAnnotations(contact, cutoff) {
  if (!cutoff || !contact) return [];
  const out = [];
  for (const row of contact.capital_contributions || []) {
    if (!row || !row.id || blank(row.entered_at)) continue;
    const entered = dayOf(row.entered_at);
    if (!entered || entered < cutoff) continue;
    if (blank(row.amount)) continue;
    const total = Math.round(Number(row.amount) * 100) / 100;
    if (!Number.isFinite(total) || total === 0) continue;
    out.push({
      capital_contribution_id: row.id,
      total,
      date: blank(row.date) ? entered : String(row.date).slice(0, 10),
      comment: conceptOf(contact.name),
    });
  }
  return out;
}

const sameAnnotation = (stored, wanted) =>
  Number(stored.total) === wanted.total &&
  (stored.date ? String(stored.date).slice(0, 10) : null) === wanted.date &&
  stored.comment === wanted.comment;

async function linkedAnnotations(contactId) {
  return strapi.db.query(TREASURY).findMany({
    where: { contact: contactId, capital_contribution_id: { $notNull: true } },
    select: ['id', 'total', 'date', 'comment', 'capital_contribution_id'],
  });
}

/**
 * Makes the contact's annotations match its contributions. Does nothing when
 * the option is off (what was already in Tresoreria stays). Returns
 * { created, updated, deleted }.
 */
async function syncContactCapitalTreasury(contactId, { cutoff } = {}) {
  const counts = { created: 0, updated: 0, deleted: 0 };
  if (!contactId) return counts;
  const from = cutoff === undefined ? await currentCutoff() : cutoff;
  if (!from) return counts;

  const contact = await strapi.db.query(CONTACT).findOne({
    where: { id: contactId },
    select: ['id', 'name'],
    populate: { capital_contributions: true },
  });
  const wanted = expectedAnnotations(contact, from);
  const stored = await linkedAnnotations(contactId);
  const byRow = new Map();
  for (const t of stored) {
    if (byRow.has(t.capital_contribution_id)) {
      // a duplicate (two saves at once): only one stays
      await strapi.db.query(TREASURY).delete({ where: { id: t.id } });
      counts.deleted++;
    } else byRow.set(t.capital_contribution_id, t);
  }

  for (const w of wanted) {
    const t = byRow.get(w.capital_contribution_id);
    byRow.delete(w.capital_contribution_id);
    if (!t) {
      await strapi.db.query(TREASURY).create({ data: { ...w, contact: contactId } });
      counts.created++;
    } else if (!sameAnnotation(t, w)) {
      await strapi.db
        .query(TREASURY)
        .update({ where: { id: t.id }, data: { total: w.total, date: w.date, comment: w.comment } });
      counts.updated++;
    }
  }
  // contributions removed (or not to be synced any more)
  for (const t of byRow.values()) {
    await strapi.db.query(TREASURY).delete({ where: { id: t.id } });
    counts.deleted++;
  }
  if (counts.created || counts.updated || counts.deleted) {
    strapi.log.info(
      `[capital-treasury] contact #${contactId}: ${counts.created} created, ${counts.updated} updated, ${counts.deleted} deleted`,
    );
  }
  return counts;
}

/** A contact deleted: its annotations go with it. */
async function deleteContactCapitalTreasury(contactId) {
  if (!contactId) return 0;
  const stored = await linkedAnnotations(contactId);
  for (const t of stored) await strapi.db.query(TREASURY).delete({ where: { id: t.id } });
  return stored.length;
}

/**
 * Every contact with a contribution entered since the cut-off, or with an
 * annotation already: run when Configuració changes the cut-off.
 */
async function syncAllCapitalTreasury() {
  const cutoff = await currentCutoff();
  if (!cutoff) return 0;
  const withRows = await strapi.db.query(CONTACT).findMany({
    where: { capital_contributions: { entered_at: { $notNull: true } } },
    select: ['id'],
  });
  const withAnnotations = await strapi.db.query(TREASURY).findMany({
    where: { capital_contribution_id: { $notNull: true } },
    select: ['id'],
    populate: { contact: { select: ['id'] } },
  });
  const ids = new Set([
    ...withRows.map((c) => c.id),
    ...withAnnotations.map((t) => t.contact && t.contact.id).filter(Boolean),
  ]);
  for (const id of ids) await syncContactCapitalTreasury(id, { cutoff });
  strapi.log.info(`[capital-treasury] cut-off ${cutoff}: ${ids.size} contacts synced`);
  return ids.size;
}

/**
 * Contact lifecycles, before a write that brings the contributions: a new row
 * is stamped with when it was entered; a row sent back with its id keeps the
 * stamp it has (whatever the request says). `storedIds` are the ids of the
 * contact's rows before the write (none on a create).
 */
function stampEnteredAt(rows, storedRows = [], now = new Date()) {
  if (!Array.isArray(rows)) return rows;
  const stored = new Map((storedRows || []).map((r) => [String(r.id), r]));
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const before = row.id !== undefined && row.id !== null ? stored.get(String(row.id)) : undefined;
    if (before) {
      if (blank(before.entered_at)) delete row.entered_at;
      else row.entered_at = before.entered_at;
    } else {
      delete row.id; // an id that is not one of this contact's rows: a new row
      row.entered_at = now;
    }
  }
  return rows;
}

/**
 * Document-service middleware (registered in src/index.js): stamps the
 * contributions before Strapi writes them. It has to be here: by the time the
 * contact lifecycles run, the components are already saved.
 */
async function stampCapitalContributions(context, next) {
  const { uid, action, params } = context;
  const rows = params && params.data && params.data.capital_contributions;
  if (uid === CONTACT && Array.isArray(rows) && (action === 'create' || action === 'update')) {
    let stored = [];
    if (action === 'update') {
      const where = params.documentId ? { documentId: params.documentId } : params.id ? { id: params.id } : null;
      const contact = where
        ? await strapi.db.query(CONTACT).findOne({
            where,
            select: ['id'],
            populate: { capital_contributions: { select: ['id', 'entered_at'] } },
          })
        : null;
      stored = (contact && contact.capital_contributions) || [];
    }
    stampEnteredAt(rows, stored);
  }
  return next();
}

/**
 * Document-service middleware: Configuració saved with a new cut-off syncs
 * every contact. Compared before and after the save (the `me` lifecycles only
 * see the options component as a reference).
 */
async function syncOnCutoffChange(context, next) {
  const { uid, action, params } = context;
  const options = params && params.data && params.data.options;
  if (uid !== ME || action !== 'update' || !options || typeof options !== 'object') return next();
  const before = await currentCutoff();
  const result = await next();
  const after = await currentCutoff();
  if (after && after !== before) await syncAllCapitalTreasury();
  return result;
}

module.exports = {
  stampCapitalContributions,
  syncOnCutoffChange,
  conceptOf,
  cutoffOf,
  currentCutoff,
  expectedAnnotations,
  syncContactCapitalTreasury,
  syncAllCapitalTreasury,
  deleteContactCapitalTreasury,
  stampEnteredAt,
};
