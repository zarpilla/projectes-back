#!/usr/bin/env node
'use strict';

/**
 * Find (and, after review, repair) `date` values that v5 stored one day early.
 *
 * Until src/services/date-fields.js, v5 kept the UTC day of the local-midnight
 * Dates the frontend sends, so every save of a form with a datepicker moved its
 * dates back a day (twice-saved rows: two days, …). This only affects rows
 * written by v5, i.e. updated since go-live.
 *
 * Two steps, run against one tenant's database (DATABASE_* env, as Strapi):
 *
 *   1. report (read-only) — writes a CSV of every date value on rows updated
 *      since --since, classified as described below:
 *
 *        node scripts/fix-shifted-dates.js report --since 2026-09-27 \
 *          [--v3-db <pre-migration v3 database>] [--out shifted-dates.csv]
 *
 *      There is no cut-off at the fix deploy: re-saving a form after the fix
 *      keeps the (already shifted) date it displays, so a later updated_at
 *      does not mean the value is right.
 *
 *      With --v3-db (a copy of the v3 database taken before go-live; v5 kept
 *      its table names and ids) each value is compared with its pre-migration
 *      value:
 *        shifted    v5 = v3 - N days: re-saved without editing that date.
 *                   suggested = v3 value, apply = yes.
 *        edited     differs from v3 by something else: the user changed it,
 *                   probably shifted once. suggested = +1 day, apply blank.
 *        new        row not in v3. suggested = +1 day, apply blank.
 *      Values equal to v3 are left out. Without --v3-db every value is `new`.
 *
 *   2. apply — after reviewing the CSV and setting `apply` to `yes` on the rows
 *      to fix (editing `suggested` where needed):
 *
 *        node scripts/fix-shifted-dates.js apply --in shifted-dates.csv
 *
 *      Writes `suggested` only where the column still holds `v5_value` (a row
 *      edited since the report is skipped), all in one transaction. Raw SQL:
 *      no lifecycles, so updated_at is untouched.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const knex = require('knex');

const MAX_SHIFT_DAYS = 31;
const CSV_COLUMNS = [
  'table', 'id', 'column', 'kind', 'parent', 'updated_at',
  'v3_value', 'v5_value', 'shift_days', 'status', 'suggested', 'apply',
];

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--')) throw new Error(`Unexpected argument ${rest[i]}`);
    args[rest[i].slice(2)] = rest[i + 1];
  }
  return args;
}

function connect(database) {
  return knex({
    client: 'mysql2',
    connection: {
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT || 3306),
      user: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database: database || process.env.DATABASE_NAME,
      // DATE columns as 'YYYY-MM-DD', never as JS Dates in the local timezone.
      dateStrings: true,
    },
  });
}

/** Every content type and component with `date` attributes, from the schemas. */
function dateSchemas() {
  const found = [];
  const apiDir = path.join(ROOT, 'src/api');
  for (const api of fs.readdirSync(apiDir)) {
    const ctDir = path.join(apiDir, api, 'content-types');
    if (!fs.existsSync(ctDir)) continue;
    for (const ct of fs.readdirSync(ctDir)) {
      const file = path.join(ctDir, ct, 'schema.json');
      if (fs.existsSync(file)) found.push({ kind: 'content-type', uid: `api::${api}.${ct}`, schema: readJson(file) });
    }
  }
  const compDir = path.join(ROOT, 'src/components');
  for (const category of fs.readdirSync(compDir)) {
    for (const file of fs.readdirSync(path.join(compDir, category))) {
      if (!file.endsWith('.json')) continue;
      const uid = `${category}.${path.basename(file, '.json')}`;
      found.push({ kind: 'component', uid, schema: readJson(path.join(compDir, category, file)) });
    }
  }
  return found
    .map(({ kind, uid, schema }) => ({
      kind,
      uid,
      table: schema.collectionName,
      columns: Object.entries(schema.attributes || {})
        .filter(([, def]) => def.type === 'date')
        .map(([name, def]) => def.columnName || name),
    }))
    .filter((s) => s.table && s.columns.length);
}

/** collectionName -> uid of every component, to tell nested parents apart. */
function allComponentTables() {
  const compDir = path.join(ROOT, 'src/components');
  const out = [];
  for (const category of fs.readdirSync(compDir)) {
    for (const file of fs.readdirSync(path.join(compDir, category))) {
      if (!file.endsWith('.json')) continue;
      const schema = readJson(path.join(compDir, category, file));
      if (schema.collectionName) out.push({ table: schema.collectionName, uid: `${category}.${path.basename(file, '.json')}` });
    }
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

async function tableExists(db, table) {
  return db.schema.hasTable(table);
}

/** Content-type rows (or component rows, via their owning entry) updated since `since`. */
async function candidateRows(db, s, since, owners) {
  const cols = s.columns.map((c) => `t.${c}`);
  if (s.kind === 'content-type') {
    return (await db(`${s.table} as t`)
      .select('t.id', ...cols, 't.updated_at as updated_at')
      .where('t.updated_at', '>=', since))
      .map((r) => ({ ...r, parent: '' }));
  }
  // A component row has no timestamps: take those of the entry that owns it,
  // walking up through nested components.
  const rows = await db(`${s.table} as t`).select('t.id', ...cols);
  const result = [];
  for (const row of rows) {
    const owner = await owners.resolve(s.uid, row.id);
    if (owner && owner.updated_at >= since) result.push({ ...row, updated_at: owner.updated_at, parent: owner.ref });
  }
  return result;
}

/**
 * Resolves a component row to the content-type entry that owns it, through the
 * <parent>_cmps join tables (several levels when components nest).
 */
function ownerResolver(db, cmpsTables, componentTables) {
  const cache = new Map();
  const timestamps = new Set();
  const resolve = async (uid, id, depth = 0) => {
    const key = `${uid}#${id}`;
    if (cache.has(key)) return cache.get(key);
    let owner = null;
    for (const cmps of cmpsTables) {
      const link = await db(cmps).select('entity_id').where({ cmp_id: id, component_type: uid }).first();
      if (!link) continue;
      const parentTable = cmps.replace(/_cmps$/, '');
      const parentUid = componentTables.get(parentTable);
      if (parentUid) {
        if (depth < 5) owner = await resolve(parentUid, link.entity_id, depth + 1);
      } else {
        if (!timestamps.has(parentTable) && !(await db.schema.hasColumn(parentTable, 'updated_at'))) continue;
        timestamps.add(parentTable);
        const parent = await db(parentTable).select('updated_at').where({ id: link.entity_id }).first();
        if (parent) owner = { updated_at: parent.updated_at, ref: `${parentTable}#${link.entity_id}` };
      }
      if (owner) break;
    }
    cache.set(key, owner);
    return owner;
  };
  return { resolve };
}

async function report(args) {
  if (!args.since || !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) throw new Error('--since YYYY-MM-DD is required');
  const out = args.out || 'shifted-dates.csv';
  const db = connect();
  const v3 = args['v3-db'] ? connect(args['v3-db']) : null;
  const cmpsTables = (await db.raw("show tables like '%\\_cmps'"))[0].map((r) => Object.values(r)[0]);
  const schemas = dateSchemas();
  const componentTables = new Map(
    allComponentTables().map(({ table, uid }) => [table, uid]),
  );
  const owners = ownerResolver(db, cmpsTables, componentTables);
  const lines = [CSV_COLUMNS.join(',')];
  const counts = { shifted: 0, edited: 0, new: 0 };

  try {
    for (const s of schemas) {
      if (!(await tableExists(db, s.table))) continue;
      const rows = await candidateRows(db, s, args.since, owners);
      if (!rows.length) continue;

      let before = new Map();
      if (v3 && (await tableExists(v3, s.table))) {
        const v3Cols = [];
        for (const c of s.columns) if (await v3.schema.hasColumn(s.table, c)) v3Cols.push(c);
        const ids = [...new Set(rows.map((r) => r.id))];
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = await v3(s.table).select('id', ...v3Cols).whereIn('id', ids.slice(i, i + 500));
          for (const r of chunk) before.set(r.id, r);
        }
      }

      const seen = new Set();
      for (const row of rows) {
        for (const column of s.columns) {
          const key = `${row.id}.${column}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const v5Value = row[column];
          if (!v5Value) continue;
          const old = before.get(row.id);
          const v3Value = old ? old[column] || '' : '';
          let status;
          let suggested;
          let apply = '';
          let shift = '';
          if (!old) {
            status = 'new';
            suggested = addDays(v5Value, 1);
          } else if (v3Value === v5Value) {
            continue;
          } else if (v3Value && daysBetween(v5Value, v3Value) >= 1 && daysBetween(v5Value, v3Value) <= MAX_SHIFT_DAYS) {
            status = 'shifted';
            shift = daysBetween(v5Value, v3Value);
            suggested = v3Value;
            apply = 'yes';
          } else {
            status = 'edited';
            suggested = addDays(v5Value, 1);
          }
          counts[status]++;
          lines.push([
            s.table, row.id, column, s.kind, row.parent, row.updated_at,
            v3Value, v5Value, shift, status, suggested, apply,
          ].map(csvCell).join(','));
        }
      }
    }
  } finally {
    await db.destroy();
    if (v3) await v3.destroy();
  }

  fs.writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(`Wrote ${lines.length - 1} values to ${out}`);
  console.log(`  shifted (apply=yes): ${counts.shifted}`);
  console.log(`  edited  (review):    ${counts.edited}`);
  console.log(`  new     (review):    ${counts.new}`);
  if (!v3) console.log('No --v3-db given: every value is "new" and needs review.');
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCsv(text) {
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const cols = header.split(',');
  return rows.map((line) => {
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] || '']));
  });
}

async function apply(args) {
  if (!args.in) throw new Error('--in <report.csv> is required');
  const known = new Map(dateSchemas().map((s) => [s.table, new Set(s.columns)]));
  const rows = parseCsv(fs.readFileSync(args.in, 'utf8')).filter((r) => r.apply.trim().toLowerCase() === 'yes');
  for (const r of rows) {
    if (!known.get(r.table)?.has(r.column)) throw new Error(`Not a date column: ${r.table}.${r.column}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.suggested)) throw new Error(`Bad suggested value for ${r.table}#${r.id}.${r.column}: ${r.suggested}`);
  }

  const db = connect();
  let updated = 0;
  const skipped = [];
  try {
    await db.transaction(async (trx) => {
      for (const r of rows) {
        const n = await trx(r.table)
          .where({ id: Number(r.id), [r.column]: r.v5_value })
          .update({ [r.column]: r.suggested });
        if (n) updated++;
        else skipped.push(`${r.table}#${r.id}.${r.column}`);
      }
    });
  } finally {
    await db.destroy();
  }
  console.log(`Updated ${updated} of ${rows.length} values marked apply=yes.`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} (value changed since the report):`);
    for (const s of skipped) console.log(`  ${s}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const commands = { report, apply };
if (!commands[args.command]) {
  console.error('Usage: fix-shifted-dates.js report --since YYYY-MM-DD [--v3-db NAME] [--out FILE]');
  console.error('       fix-shifted-dates.js apply --in FILE');
  process.exit(1);
}
commands[args.command](args).catch((e) => {
  console.error(e);
  process.exit(1);
});
