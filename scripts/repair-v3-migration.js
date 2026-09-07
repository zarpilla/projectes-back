'use strict';

/**
 * Repairs a v5 database migrated by an older ETL, without re-running it.
 *
 * Two defects lost data silently. Re-running the ETL fixes both, but it
 * TRUNCATEs every table, so it is not an option once a tenant has been worked
 * in. This repairs in place instead.
 *
 * 1. Renamed columns. Strapi's snake_case splits digit groups and camelCase
 *    words that Bookshelf stored verbatim — `face_dir3_oc` becomes
 *    `face_dir_3_oc`, `less15` becomes `less_15`, `costByHour` becomes
 *    `cost_by_hour`. The ETL matched column names exactly, so those columns
 *    were never copied. Among the casualties: every price in route_rates, the
 *    FACe DIR3 codes, and serials.leadingZeros.
 *
 * 2. Media links. v3 stored `related_type` as the model/table name ("us",
 *    "received_expenses"); v5 wants the content-type UID ("api::me.me").
 *    Copied verbatim, every attachment is orphaned — logos, certificates and
 *    expense documents all resolve to null.
 *
 * Only fills v5 values that are NULL, and only from a v3 row with the same id,
 * so anything entered or edited since the migration is left alone. Rows created
 * after the migration have no v3 counterpart and are untouched.
 *
 *   node scripts/repair-v3-migration.js --from <v3db> --to <v5db> [--dry-run]
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const { loadRegistry } = require('../tools/etl/lib/registry');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const FROM = arg('--from');
const TO = arg('--to');
const DRY = process.argv.includes('--dry-run');

if (!FROM || !TO) {
  console.error('Usage: node scripts/repair-v3-migration.js --from <v3db> --to <v5db> [--dry-run]');
  process.exit(1);
}

const squash = (name) => name.replace(/_/g, '').toLowerCase();

(async () => {
  const db = await mysql.createConnection({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 3306),
    user: process.env.DATABASE_USERNAME || 'admin',
    password: process.env.DATABASE_PASSWORD,
    multipleStatements: false,
  });

  console.log(`${FROM} -> ${TO}${DRY ? '  (dry run)' : ''}\n`);

  // ── 1. columns Strapi renamed ────────────────────────────────────────────
  const [columns] = await db.query(
    'SELECT table_schema s, table_name t, column_name c FROM information_schema.columns WHERE table_schema IN (?, ?)',
    [FROM, TO],
  );
  const byDb = {};
  for (const row of columns) {
    ((byDb[row.s] ||= {})[row.t] ||= []).push(row.c);
  }

  let repaired = 0;
  for (const [table, v3Cols] of Object.entries(byDb[FROM] || {})) {
    const v5Cols = byDb[TO] && byDb[TO][table];
    if (!v5Cols || !v5Cols.includes('id') || !v3Cols.includes('id')) continue;

    const v5Set = new Set(v5Cols);
    const v5BySquash = new Map(v5Cols.map((c) => [squash(c), c]));

    for (const from of v3Cols) {
      if (v5Set.has(from)) continue;                 // copied correctly already
      const to = v5BySquash.get(squash(from));
      if (!to) continue;                             // genuinely absent in v5

      const [[pending]] = await db.query(
        `SELECT COUNT(*) n FROM \`${TO}\`.\`${table}\` v5
         JOIN \`${FROM}\`.\`${table}\` v3 ON v3.id = v5.id
         WHERE v5.\`${to}\` IS NULL AND v3.\`${from}\` IS NOT NULL`,
      );
      if (pending.n === 0) continue;

      console.log(`  ${table}.${from} -> ${to}: ${pending.n} value(s)`);
      repaired += pending.n;
      if (!DRY) {
        await db.query(
          `UPDATE \`${TO}\`.\`${table}\` v5
           JOIN \`${FROM}\`.\`${table}\` v3 ON v3.id = v5.id
           SET v5.\`${to}\` = v3.\`${from}\`
           WHERE v5.\`${to}\` IS NULL AND v3.\`${from}\` IS NOT NULL`,
        );
      }
    }
  }
  console.log(`  ${repaired} column value(s) ${DRY ? 'to restore' : 'restored'}\n`);

  // ── 2. media links pointing at a v3 table name ───────────────────────────
  const { contentTypes } = loadRegistry();
  const tableToUid = new Map(contentTypes.filter((c) => c.table && c.uid).map((c) => [c.table, c.uid]));

  const [broken] = await db.query(
    `SELECT related_type, COUNT(*) n FROM \`${TO}\`.files_related_mph
     WHERE related_type NOT LIKE 'api::%' AND related_type NOT LIKE 'plugin::%'
     GROUP BY related_type`,
  );
  let relinked = 0;
  for (const row of broken) {
    const uid = tableToUid.get(row.related_type);
    if (!uid) {
      console.log(`  ! ${row.n} link(s) on "${row.related_type}" — no v5 content type uses that table, left alone`);
      continue;
    }
    console.log(`  ${row.related_type} -> ${uid}: ${row.n} link(s)`);
    relinked += row.n;
    if (!DRY) {
      await db.query(`UPDATE \`${TO}\`.files_related_mph SET related_type = ? WHERE related_type = ?`, [uid, row.related_type]);
    }
  }
  console.log(`  ${relinked} media link(s) ${DRY ? 'to re-point' : 're-pointed'}`);

  await db.end();
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
