'use strict';
/* global strapi */

/**
 * A project's stored totals live in their own table, `project_totals`, one row
 * per project (issues/328).
 *
 * They used to be columns of `projects`. Every hours entry marked its project
 * `dirty` and the totals cron wrote the totals two minutes later: two writes to
 * `projects` per change, all day, and the read cache (issues/307) drops what it
 * keeps per table, so everything that read a project was loaded again —
 * on raiels the Tresoreria forecast was rebuilt 8 times in 26 minutes. Now
 * those writes go to `project_totals` and `projects` changes only when a
 * project does.
 *
 * The API doesn't change: every project read through `strapi.db.query` (core
 * find / findOne, projects/basic, mother sums, …) gets its totals and `dirty`
 * back from here in the project lifecycles (afterFindMany / afterFindOne). A
 * read with a `select` that names none of them gets nothing: the forecast reads
 * projects that way and doesn't depend on this table.
 *
 * Writes join the transaction in progress (a project PUT marks its project
 * dirty inside one): `strapi.db.transaction` reuses it, so the row lock and the
 * foreign key check never wait on ourselves.
 *
 * The table is plain SQL, not a content type: Strapi leaves tables it didn't
 * create alone. Created by database/migrations (copying the old columns) and,
 * for a database that had no projects yet, by `ensureProjectTotals` at boot.
 */

const { STORED_TOTAL_FIELDS } = require('./projectFinancials');

const TABLE = 'project_totals';

/** The stored totals: the cron's fields plus the two legacy mirrors the PUT writes. */
const TOTAL_COLUMNS = [...STORED_TOTAL_FIELDS, 'total_expenses_hours', 'total_expenses_vat'];

/** Everything the table holds per project besides its id. */
const COLUMNS = [...TOTAL_COLUMNS, 'dirty'];

const CHUNK = 1000;

const chunks = (list) => {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
};

/** Runs fn(knex) in the transaction in progress, if any; else on the pool. */
function withConnection(fn) {
  const db = strapi.db;
  if (db.inTransaction && db.inTransaction()) return db.transaction(({ trx }) => fn(trx));
  return fn(db.connection);
}

/** CREATE TABLE IF NOT EXISTS, with the old columns' types (decimal 10,2). */
async function createTable(knex) {
  if (await knex.schema.hasTable(TABLE)) return false;
  await knex.schema.createTable(TABLE, (t) => {
    t.integer('project_id').unsigned().primary();
    for (const c of TOTAL_COLUMNS) t.decimal(c, 10, 2).nullable();
    t.boolean('dirty').nullable();
    t.foreign('project_id', 'project_totals_project_id_fk').references('id').inTable('projects').onDelete('CASCADE');
    t.index(['dirty'], 'project_totals_dirty_idx');
  });
  return true;
}

const toNumber = (v) => (v === null || v === undefined ? null : Number(v));
const toBoolean = (v) => (v === null || v === undefined ? null : Boolean(Number(v)));

/** A stored row as the API gave the old columns: numbers, booleans, nulls. */
function fromRow(row) {
  const out = {};
  for (const c of TOTAL_COLUMNS) out[c] = row ? toNumber(row[c]) : null;
  // a project without a row yet waits for its first totals; `dirty` was false by default
  out.dirty = row ? toBoolean(row.dirty) === true : false;
  return out;
}

/**
 * Should a project read get its totals? Yes unless it chose its columns with a
 * `select` that names none of them.
 */
function wantsTotals(params) {
  const select = params && params.select;
  if (select === undefined || select === null || select === '*') return true;
  const list = Array.isArray(select) ? select : [select];
  return list.some((c) => c === '*' || COLUMNS.includes(c));
}

/** The stored rows of these projects: Map id → row. */
async function readRows(ids, knex) {
  const byId = new Map();
  for (const part of chunks(ids)) {
    const rows = await knex(TABLE).select('project_id', ...COLUMNS).whereIn('project_id', part);
    for (const r of rows) byId.set(Number(r.project_id), r);
  }
  return byId;
}

/**
 * Puts each project's totals and `dirty` on it (in place), and on its mother
 * when that was populated whole: null when it has no row yet, like a new
 * project's empty columns before.
 */
// a populated mother read whole (not just its id), as populate gave the columns
const wholeRow = (p) => p && typeof p === 'object' && p.id !== undefined && Object.keys(p).some((k) => k !== 'id' && k !== 'documentId');

async function attachTotals(projects) {
  const top = (Array.isArray(projects) ? projects : [projects]).filter((p) => p && p.id !== undefined);
  const list = [...top, ...top.map((p) => p.mother).filter(wholeRow)];
  if (!list.length) return projects;
  const ids = [...new Set(list.map((p) => Number(p.id)))];
  const byId = await withConnection((knex) => readRows(ids, knex));
  for (const p of list) Object.assign(p, fromRow(byId.get(Number(p.id))));
  return projects;
}

/** The totals of one project, as the API gives them (null fields without a row). */
async function readTotals(id) {
  const byId = await withConnection((knex) => readRows([Number(id)], knex));
  return fromRow(byId.get(Number(id)));
}

/** Marks projects dirty for the totals cron (creates their rows if missing). */
async function markDirty(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter((id) => id > 0))];
  if (!list.length) return 0;
  await withConnection(async (knex) => {
    for (const part of chunks(list)) {
      await knex(TABLE)
        .insert(part.map((project_id) => ({ project_id, dirty: true })))
        .onConflict('project_id')
        .merge(['dirty']);
    }
  });
  return list.length;
}

/** Marks every project dirty (after an ETL rebuild, a restore…). */
async function markAllDirty() {
  return withConnection(async (knex) => {
    const rows = await knex('projects').select('id');
    return markDirty(rows.map((r) => r.id));
  });
}

/**
 * Writes a project's totals. `dirty` is written only when given (the cron
 * clears it; a project PUT leaves it as it is).
 */
async function writeTotals(id, totals, { dirty } = {}) {
  const row = { project_id: Number(id) };
  for (const c of TOTAL_COLUMNS) if (totals && totals[c] !== undefined) row[c] = totals[c];
  if (dirty !== undefined) row.dirty = dirty;
  const update = Object.keys(row).filter((k) => k !== 'project_id');
  if (!update.length) return;
  await withConnection((knex) => knex(TABLE).insert(row).onConflict('project_id').merge(update));
}

/** Ids of the projects waiting for the totals cron. */
async function dirtyIds() {
  const rows = await strapi.db.connection(TABLE).where({ dirty: true }).select('project_id');
  return rows.map((r) => Number(r.project_id));
}

/** How many projects wait for the totals cron. */
async function dirtyCount() {
  const [row] = await strapi.db.connection(TABLE).where({ dirty: true }).count('project_id as n');
  return Number((row && row.n) || 0);
}

/**
 * Every boot (cheap, idempotent): the table exists, and a project without a
 * row gets one marked dirty, so the cron computes its totals. Covers a new
 * tenant, an ETL rebuild (the ETL copies only the project's own columns) and
 * a project inserted by hand.
 */
async function ensureProjectTotals() {
  const knex = strapi.db.connection;
  const created = await createTable(knex);
  const missing = await knex('projects')
    .select('projects.id')
    .leftJoin(TABLE, `${TABLE}.project_id`, 'projects.id')
    .whereNull(`${TABLE}.project_id`);
  const marked = await markDirty(missing.map((r) => r.id));
  if (created || marked) {
    strapi.log.info(`[project-totals] ${created ? 'table created; ' : ''}${marked} projects without totals marked dirty`);
  }
  return { created, marked };
}

module.exports = {
  TABLE,
  TOTAL_COLUMNS,
  COLUMNS,
  createTable,
  fromRow,
  wantsTotals,
  attachTotals,
  readTotals,
  markDirty,
  markAllDirty,
  writeTotals,
  dirtyIds,
  dirtyCount,
  ensureProjectTotals,
};
