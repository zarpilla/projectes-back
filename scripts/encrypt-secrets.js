'use strict';

/**
 * One-off: encrypt secrets that are still stored as plaintext.
 *
 * Rows migrated from v3 hold their certificate passphrases and API keys in the
 * clear. The app reads either form (see services/secret-crypto.js), so this is
 * not required for correctness — but until it runs, those values sit readable
 * in every database dump and backup.
 *
 * Safe to re-run: already-encrypted values are skipped.
 *
 *   node scripts/encrypt-secrets.js            # encrypt
 *   node scripts/encrypt-secrets.js --dry-run  # report what would change
 *
 * Uses the same SECRETS_KEY / APP_KEYS the running app does, so run it with the
 * environment of the instance whose database it is pointed at.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const { encryptSecret, isEncrypted } = require('../src/services/secret-crypto');

// Table names as Strapi created them, with the column names it derived.
const TARGETS = [
  ['verifactus', ['certificate_password']],
  ['us', ['face_certificate_password', 'certificate_pwd', 'dir_3_api_token', 'invoice_parser_api_token']],
];

const dryRun = process.argv.includes('--dry-run');

(async () => {
  const db = await mysql.createConnection({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: process.env.DATABASE_PORT || 3306,
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  });

  console.log(`database: ${process.env.DATABASE_NAME}${dryRun ? '  (dry run)' : ''}`);
  let changed = 0;
  let already = 0;

  for (const [table, columns] of TARGETS) {
    const [described] = await db.query(`SHOW COLUMNS FROM \`${table}\``);
    const present = new Set(described.map((c) => c.Field));
    const usable = columns.filter((c) => present.has(c));
    if (usable.length === 0) continue;

    const select = usable.map((c) => `\`${c}\``).join(', ');
    const [rows] = await db.query(`SELECT id, ${select} FROM \`${table}\``);

    for (const row of rows) {
      for (const column of usable) {
        const value = row[column];
        if (!value) continue;
        if (isEncrypted(value)) {
          already += 1;
          continue;
        }
        // Never log the secret itself, only that one was found.
        console.log(`  ${dryRun ? 'would encrypt' : 'encrypted'} ${table}.${column} (id ${row.id})`);
        if (!dryRun) {
          await db.query(`UPDATE \`${table}\` SET \`${column}\` = ? WHERE id = ?`, [
            encryptSecret(value),
            row.id,
          ]);
        }
        changed += 1;
      }
    }
  }

  await db.end();
  console.log(`${changed} value(s) ${dryRun ? 'to encrypt' : 'encrypted'}, ${already} already encrypted`);
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
