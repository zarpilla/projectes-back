'use strict';

// Connection details come from .env, the same file the app uses.
require('dotenv').config();

/**
 * Post-migration NULL audit. For every table that exists in both the v3
 * source and the migrated v5 DB (joined row-by-row on the preserved numeric
 * id), reports columns whose NULL-ness changed:
 *
 *   lost   = v3 had a value, v5 is NULL      <-- suspicious, data dropped
 *   gained = v3 was NULL, v5 has a value     <-- usually v5-managed defaults
 *
 * Columns Strapi renamed between versions (face_dir3_oc -> face_dir_3_oc,
 * costByHour -> cost_by_hour, …) are paired with the same squash() fallback
 * migrate.js uses, so renamed columns are audited too.
 *
 * Usage:
 *   node tools/etl/nullcheck.js --from diligencia --to projectes_v5_diligencia
 *
 * Exit code 0 = nothing suspicious; 1 = at least one lost-value column.
 */
const mysql = require('mysql2/promise');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const FROM = flag('from');
const TO = flag('to');
if (!FROM || !TO) {
  console.error('Usage: node tools/etl/nullcheck.js --from <v3db> --to <v5db>');
  process.exit(1);
}

const squash = (name) => name.replace(/_/g, '').toLowerCase();

// Tables whose rows don't keep v3 ids (join tables, morph tables, v5 system
// tables) — a per-row comparison there is meaningless.
const SKIP_TABLE =
  /(_lnk|_cmps|_mph$)/i;

// v3 table -> v5 table renames to audit beyond the exact-name intersection.
const TABLE_RENAMES = new Map([['upload_file', 'files']]);

// v5-managed columns: v5 fills these itself, so "gained" values there are
// expected and only reported as a one-line note, not flagged.
const V5_MANAGED = new Set([
  'document_id',
  'published_at',
  'locale',
  'created_at',
  'updated_at',
  'created_by_id',
  'updated_by_id',
]);

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 3306),
    user: process.env.DATABASE_USERNAME || 'admin',
    password: process.env.DATABASE_PASSWORD,
  });

  const [v3t] = await conn.query(`SHOW TABLES FROM \`${FROM}\``);
  const [v5t] = await conn.query(`SHOW TABLES FROM \`${TO}\``);
  const v3Tables = new Set(v3t.map((r) => Object.values(r)[0]));
  const v5Tables = new Set(v5t.map((r) => Object.values(r)[0]));

  const pairsOfTables = [];
  for (const t of v3Tables) {
    if (SKIP_TABLE.test(t)) continue;
    const v5Name = v5Tables.has(t) ? t : TABLE_RENAMES.get(t);
    if (v5Name && v5Tables.has(v5Name)) pairsOfTables.push({ v3: t, v5: v5Name });
  }

  const findings = [];
  const notes = [];
  let checked = 0;

  for (const { v3, v5 } of pairsOfTables) {
    const [v3c] = await conn.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
      [FROM, v3],
    );
    const [v5c] = await conn.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
      [TO, v5],
    );
    const v3Cols = new Set(v3c.map((r) => r.column_name || r.COLUMN_NAME));
    const v5Cols = new Set(v5c.map((r) => r.column_name || r.COLUMN_NAME));
    if (!v3Cols.has('id') || !v5Cols.has('id')) continue;

    // Pair columns: exact name first, then squashed (renamed) fallback.
    const v5BySquash = new Map();
    for (const c of v5Cols) if (!v5BySquash.has(squash(c))) v5BySquash.set(squash(c), c);
    const colPairs = [];
    const seen = new Set();
    for (const c of v3Cols) {
      if (c === 'id') continue;
      const to = v5Cols.has(c) ? c : v5BySquash.get(squash(c));
      if (!to || seen.has(to)) continue;
      seen.add(to);
      colPairs.push({ from: c, to });
    }
    if (colPairs.length === 0) continue;
    checked++;

    const sums = colPairs
      .map(
        ({ from, to }, i) =>
          `SUM(a.\`${from}\` IS NOT NULL) AS v3_${i}, ` +
          `SUM(b.\`${to}\` IS NOT NULL) AS v5_${i}, ` +
          `SUM(a.\`${from}\` IS NOT NULL AND b.\`${to}\` IS NULL) AS lost_${i}, ` +
          `SUM(a.\`${from}\` IS NULL AND b.\`${to}\` IS NOT NULL) AS gained_${i}`,
      )
      .join(', ');

    const [rows] = await conn.query(
      `SELECT COUNT(*) AS joined, ${sums} ` +
        `FROM \`${FROM}\`.\`${v3}\` a JOIN \`${TO}\`.\`${v5}\` b ON a.id = b.id`,
    );
    const row = rows[0];
    if (!row || !row.joined) continue;

    for (const [i, { from, to }] of colPairs.entries()) {
      const v3n = Number(row[`v3_${i}`] || 0);
      const v5n = Number(row[`v5_${i}`] || 0);
      const lost = Number(row[`lost_${i}`] || 0);
      const gained = Number(row[`gained_${i}`] || 0);
      if (lost > 0) {
        findings.push({
          table: v3,
          column: from,
          v5Column: to,
          joined: row.joined,
          v3NonNullOrNull: v3n,
          v5NonNull: v5n,
          lost,
        });
      } else if (gained > 0 && !V5_MANAGED.has(to)) {
        notes.push({
          table: v3,
          column: from,
          v5Column: to,
          joined: row.joined,
          gained,
        });
      }
    }
  }

  console.log(`──── NULL AUDIT ${FROM} -> ${TO} ────`);
  console.log(`Tables audited: ${checked}`);

  if (findings.length === 0) {
    console.log('✓ no lost values — every v3-populated column is populated in v5');
  } else {
    console.log(`\n!! LOST VALUES (v3 populated, v5 NULL) — ${findings.length} column(s):`);
    findings
      .sort((a, b) => b.lost - a.lost)
      .forEach((f) => {
        const rename = f.column !== f.v5Column ? ` (renamed to ${f.v5Column})` : '';
        console.log(
          `  ${f.table}.${f.column}${rename}: ${f.lost}/${f.joined} joined rows lost ` +
            `(v3 non-null: ${f.v3NonNullOrNull}, v5 non-null: ${f.v5NonNull})`,
        );
      });
  }

  if (notes.length) {
    console.log(`\nnotes — v5 gained values where v3 was NULL (${notes.length}):`);
    notes
      .sort((a, b) => b.gained - a.gained)
      .forEach((n) => {
        const rename = n.column !== n.v5Column ? ` (renamed to ${n.v5Column})` : '';
        console.log(`  ${n.table}.${n.column}${rename}: gained on ${n.gained}/${n.joined} rows`);
      });
  }

  await conn.end();
  process.exit(findings.length ? 1 : 0);
}

main().catch((e) => {
  console.error('NULL AUDIT FAILED:', e.message);
  process.exit(1);
});
