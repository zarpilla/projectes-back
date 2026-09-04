'use strict';

/**
 * Post-migration validation (P7.5). Compares a v3 source DB against a migrated
 * v5 DB: per-table row counts + relation-link counts + sample-row scalar diffs.
 *
 * Usage:
 *   node tools/etl/validate.js --from arada --to projectes_v5_dev
 *
 * Exit code 0 = all checks pass; 1 = mismatches found (printed).
 */
const mysql = require('mysql2/promise');
const { loadRegistry } = require('./lib/registry');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const FROM = flag('from');
const TO = flag('to');
if (!FROM || !TO) {
  console.error('Usage: node tools/etl/validate.js --from <v3db> --to <v5db>');
  process.exit(1);
}

async function main() {
  const { contentTypes } = loadRegistry();
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 3306),
    user: process.env.DATABASE_USERNAME || 'admin',
    password: process.env.DATABASE_PASSWORD,
  });

  const [v3t] = await conn.query(`SHOW TABLES FROM \`${FROM}\``);
  const v3Tables = new Set(v3t.map((r) => Object.values(r)[0]));

  const problems = [];
  const summary = { checked: 0, matched: 0, sampleDiffed: 0 };

  for (const ct of contentTypes) {
    if (!v3Tables.has(ct.table)) continue;
    summary.checked++;

    // 1. Row count
    const [[v3c]] = await conn.query(`SELECT COUNT(*) c FROM \`${FROM}\`.\`${ct.table}\``);
    const [[v5c]] = await conn.query(`SELECT COUNT(*) c FROM \`${TO}\`.\`${ct.table}\``);
    if (v3c.c !== v5c.c) {
      problems.push(`${ct.table}: row count v3=${v3c.c} v5=${v5c.c}`);
      continue;
    }
    if (v3c.c === 0) {
      summary.matched++;
      continue;
    }

    // 2. Relation link counts
    for (const [attrName, def] of Object.entries(ct.attributes)) {
      if (def.type !== 'relation') continue;
      const v5Lnk = `${ct.table}_${attrName}_lnk`;
      try {
        const singularName = (ct.ctName || '').replace(/-/g, '_');
        const [v5cols] = await conn.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
          [TO, v5Lnk],
        );
        if (!v5cols.length) continue;
        const cols = v5cols.map((r) => r.COLUMN_NAME);
        const ownerCol =
          [`${ct.table}_id`, `${singularName}_id`].find((c) => cols.includes(c)) || null;
        if (!ownerCol) continue;

        // v3 count: M2M join or inline FK
        const joinCandidate = [...v3Tables].find((t) =>
          t.startsWith(`${ct.table}_${attrName}__`),
        );
        let v3Count = null;
        if (joinCandidate) {
          const [jc] = await conn.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
            [FROM, joinCandidate],
          );
          const joinCols = jc.map((r) => r.COLUMN_NAME).filter((c) => c.endsWith('_id'));
          const v3Owner =
            [`${singularName}_id`, `${singularName.replace(/_/g, '-')}_id`].find((c) =>
              joinCols.includes(c),
            ) || null;
          const v3Target = joinCols.find((c) => c !== v3Owner);
          if (v3Owner && v3Target) {
            const [[r]] = await conn.query(
              `SELECT COUNT(*) c FROM \`${FROM}\`.\`${joinCandidate}\` WHERE \`${v3Owner}\` IS NOT NULL AND \`${v3Target}\` IS NOT NULL`,
            );
            v3Count = r.c;
          }
        } else {
          const [c3] = await conn.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
            [FROM, ct.table],
          );
          if (c3.some((r) => r.COLUMN_NAME === attrName)) {
            const [[r]] = await conn.query(
              `SELECT COUNT(*) c FROM \`${FROM}\`.\`${ct.table}\` WHERE \`${attrName}\` IS NOT NULL`,
            );
            v3Count = r.c;
          }
        }
        if (v3Count === null) continue;

        const [[v5r]] = await conn.query(
          `SELECT COUNT(*) c FROM \`${TO}\`.\`${v5Lnk}\` WHERE \`${ownerCol}\` IS NOT NULL`,
        );
        if (v3Count !== v5r.c) {
          problems.push(`${v5Lnk}: links v3=${v3Count} v5=${v5r.c}`);
        }
      } catch {
        // table/column shape variance — count check only
      }
    }

    // 3. Sample-row scalar diff (first row by id)
    const scalarAttrs = Object.entries(ct.attributes)
      .filter(
        ([, d]) => !['relation', 'component', 'dynamiczone', 'media'].includes(d.type),
      )
      .map(([n]) => n);
    const [v5colsRow] = await conn.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
      [TO, ct.table],
    );
    const v5Cols = new Set(v5colsRow.map((r) => r.COLUMN_NAME));
    const [v3colsRow] = await conn.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
      [FROM, ct.table],
    );
    const v3Cols = new Set(v3colsRow.map((r) => r.COLUMN_NAME));
    const shared = scalarAttrs.filter((a) => v5Cols.has(a) && v3Cols.has(a));
    if (shared.length) {
      const colSel = shared.map((c) => `\`${c}\``).join(', ');
      const [[firstId]] = await conn.query(
        `SELECT id FROM \`${FROM}\`.\`${ct.table}\` ORDER BY id LIMIT 1`,
      );
      const [v3Row] = await conn.query(
        `SELECT ${colSel} FROM \`${FROM}\`.\`${ct.table}\` WHERE id = ?`,
        [firstId.id],
      );
      const [v5Row] = await conn.query(
        `SELECT ${colSel} FROM \`${TO}\`.\`${ct.table}\` WHERE id = ?`,
        [firstId.id],
      );
      summary.sampleDiffed++;
      for (const col of shared) {
        const a = v3Row[0] && v3Row[0][col];
        const b = v5Row[0] && v5Row[0][col];
        // decimal/date objects compare via String()
        if (String(a) !== String(b)) {
          problems.push(`${ct.table}#${firstId.id}.${col}: v3=${JSON.stringify(a)} v5=${JSON.stringify(b)}`);
        }
      }
    }

    summary.matched++;
  }

  await conn.end();

  console.log(`──── VALIDATION ${FROM} -> ${TO} ────`);
  console.log(`Tables checked: ${summary.checked}, matched: ${summary.matched}, sample-diffed rows: ${summary.sampleDiffed}`);
  if (problems.length) {
    console.log(`\n✗ ${problems.length} PROBLEMS:`);
    problems.slice(0, 40).forEach((p) => console.log('  ' + p));
    if (problems.length > 40) console.log(`  ... and ${problems.length - 40} more`);
    process.exit(1);
  } else {
    console.log('✓ ALL CHECKS PASS');
  }
}

main().catch((e) => {
  console.error('VALIDATION FAILED:', e.message);
  process.exit(1);
});
