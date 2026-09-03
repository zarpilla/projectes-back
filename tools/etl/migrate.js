'use strict';

/**
 * ETL: migrate one tenant's data from a v3 database to a v5 database (P7.2).
 * See tools/etl/DESIGN.md for the storage-model mapping.
 *
 * Usage:
 *   node tools/etl/migrate.js --from arada --to projectes_v5_dev [--dry-run] [--only ct1,ct2]
 *
 * Raw SQL INSERT...SELECT between databases; numeric ids preserved;
 * document_id generated; FK checks disabled during load.
 */
const mysql = require('mysql2/promise');
const { loadRegistry } = require('./lib/registry');

// ── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const FROM = flag('from');
const TO = flag('to');
const DRY = args.includes('--dry-run');
const ONLY = flag('only') ? flag('only').split(',') : null;

if (!FROM || !TO) {
  console.error('Usage: node tools/etl/migrate.js --from <v3db> --to <v5db> [--dry-run] [--only ct,ct]');
  process.exit(1);
}

// v3 admin audit columns (created_by/updated_by) are not migrated — different admin user tables.

async function main() {
  const { contentTypes, components } = loadRegistry();
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 3306),
    user: process.env.DATABASE_USERNAME || 'admin',
    password: process.env.DATABASE_PASSWORD,
    multipleStatements: false,
  });

  const [v3Tables] = await conn.query(`SHOW TABLES FROM \`${FROM}\``);
  const v3TableNames = new Set(v3Tables.map((r) => Object.values(r)[0]));
  const [v3ColsByTable] = await conn.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = ?`,
    [FROM],
  );
  const v3Columns = {};
  for (const { TABLE_NAME, COLUMN_NAME } of v3ColsByTable) {
    (v3Columns[TABLE_NAME] = v3Columns[TABLE_NAME] || new Set()).add(COLUMN_NAME);
  }

  const stats = { copied: [], skippedMissing: [], relations: [], components: 0 };

  if (!DRY) {
    await conn.query(`SET FOREIGN_KEY_CHECKS=0`);
  }

  try {
    // ── 1. Core scalar rows per content type ────────────────────────────────
    for (const ct of contentTypes) {
      if (ONLY && !ONLY.includes(ct.apiName)) continue;
      if (!v3TableNames.has(ct.table)) {
        stats.skippedMissing.push(ct.table);
        continue;
      }
      const v3Cols = v3Columns[ct.table];
      const [v5ColsRows] = await conn.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
        [TO, ct.table],
      );
      const v5Cols = new Set(v5ColsRows.map((r) => r.COLUMN_NAME));

      // Scalar (non-relation) attributes both schemas share.
      const scalarAttrs = Object.entries(ct.attributes)
        .filter(([name, def]) => !['relation', 'component', 'dynamiczone', 'media'].includes(def.type))
        .map(([name]) => name);

      const shared = scalarAttrs.filter((a) => v3Cols.has(a) && v5Cols.has(a));
      const colList = ['id', ...shared, 'created_at', 'updated_at', 'published_at']
        .filter((c) => v3Cols.has(c) && v5Cols.has(c));

      const selectExprs = colList.map((c) =>
        c === 'id' ? 'id' : `\`${c}\``,
      );
      // document_id for v5
      const insertCols = colList.includes('document_id') ? colList : ['document_id', ...colList];
      const docIdx = insertCols.indexOf('document_id');
      const selectParts = [...selectExprs];
      selectParts.splice(docIdx, 0, 'UUID()');

      const sql =
        `INSERT INTO \`${TO}\`.\`${ct.table}\` (${insertCols.map((c) => `\`${c}\``).join(', ')}) ` +
        `SELECT ${selectParts.join(', ')} FROM \`${FROM}\`.\`${ct.table}\``;

      if (DRY) {
        console.log(`[dry] ${ct.table}: would copy ${colList.length} cols`);
      } else {
        await conn.query(`TRUNCATE TABLE \`${TO}\`.\`${ct.table}\``);
        const [res] = await q(conn, sql);
        stats.copied.push({ table: ct.table, rows: res.affectedRows });
      }
    }

    // ── 2. Component data rows (identical tables in both) ──────────────────
    for (const comp of components) {
      if (!v3TableNames.has(comp.table)) continue;
      const scalarAttrs = Object.entries(comp.attributes)
        .filter(([n, d]) => !['relation', 'component', 'dynamiczone', 'media'].includes(d.type))
        .map(([n]) => n);
      const v3Cols = v3Columns[comp.table];
      const [v5c] = await conn.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
        [TO, comp.table],
      );
      const v5Cols = new Set(v5c.map((r) => r.COLUMN_NAME));
      const colList = ['id', ...scalarAttrs.filter((a) => v3Cols.has(a) && v5Cols.has(a))]
        .filter((c) => v3Cols.has(c) && v5Cols.has(c));
      if (!colList.includes('id')) continue;

      const sql =
        `INSERT INTO \`${TO}\`.\`${comp.table}\` (${colList.map((c) => `\`${c}\``).join(', ')}) ` +
        `SELECT ${colList.map((c) => `\`${c}\``).join(', ')} FROM \`${FROM}\`.\`${comp.table}\``;
      if (DRY) {
        console.log(`[dry] ${comp.table}: component copy`);
      } else {
        await conn.query(`TRUNCATE TABLE \`${TO}\`.\`${comp.table}\``);
        const [res] = await q(conn, sql);
        stats.components += res.affectedRows;
      }
    }

    // ── 3. Component links: v3 <t>_components -> v5 <t>_cmps ────────────────
    const linkTables = [...v3TableNames].filter((t) => t.endsWith('_components'));
    for (const v3Link of linkTables) {
      const base = v3Link.slice(0, -'_components'.length);
      const v5Link = `${base}_cmps`;
      const [v5c] = await conn.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
        [TO, v5Link],
      );
      if (!v5c.length) continue; // not a v5 cmps table
      const has = (rows, c) => rows.some((r) => r.COLUMN_NAME === c);
      const v5HasEntity = has(v5c, 'entity_id') && has(v5c, 'cmp_id');
      if (!v5HasEntity) continue;
      // v3 link columns: field, order, component_type, component_id, <base>_id
      const v3IdCol = [...v3Columns[v3Link]].find((c) => c.endsWith('_id') && c !== 'component_id');
      if (!v3IdCol) continue;
      const sql =
        `INSERT INTO \`${TO}\`.\`${v5Link}\` (entity_id, cmp_id, component_type, field, \`order\`) ` +
        `SELECT \`${v3IdCol}\`, component_id, component_type, field, \`order\` FROM \`${FROM}\`.\`${v3Link}\``;
      if (DRY) {
        console.log(`[dry] ${v5Link}: component links`);
      } else {
        await conn.query(`TRUNCATE TABLE \`${TO}\`.\`${v5Link}\``);
        await q(conn, sql);
      }
    }

    // ── 4. Relation links: v3 FK column or M2M join -> v5 <t>_<attr>_lnk ───
    const allEntities = [
      ...contentTypes.map((c) => ({ ...c, isComp: false })),
      ...components.map((c) => ({ ...c, isComp: true })),
    ];
    for (const ent of allEntities) {
      if (!ent.table || !v3TableNames.has(ent.table)) continue;
      const apiFilter = ent.isComp ? null : ent.apiName;
      if (ONLY && apiFilter && !ONLY.includes(apiFilter)) continue;

      for (const [attrName, def] of Object.entries(ent.attributes)) {
        if (def.type !== 'relation') continue;
        // v5 lnk table: <table>_<attr>_lnk
        const v5Lnk = `${ent.table}_${attrName}_lnk`;
        const [v5c] = await conn.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
          [TO, v5Lnk],
        );
        if (!v5c.length) continue;
        const cols = v5c.map((r) => r.COLUMN_NAME);
        // v5 lnk columns: <owner>_id and <target>_id (find the one that's not owner)
        // v5 names the owner column after the CT (singular, e.g. activity_id) OR
        // the collection table (plural, activities_id) — accept either.
        const singularName = (ent.ctName || ent.compName || ent.table)
          .split('.')
          .pop()
          .replace(/-/g, '_');
        const ownerCandidates = [
          `${ent.table.replace(/-/g, '_')}_id`,
          `${singularName}_id`,
          ...(ent.isComp ? ['component_id'] : []),
        ];
        const ownerCol = ownerCandidates.find((c) => cols.includes(c));
        const targetCol = cols.find((c) => c.endsWith('_id') && c !== ownerCol);
        if (!ownerCol || !targetCol) continue;

        // v3 source A: M2M join table <table>_<attr>__<something>
        const joinCandidate = [...v3TableNames].find(
          (t) => t.startsWith(`${ent.table}_${attrName}__`),
        );
        // v3 source B: inline FK column <table>.<attr>
        const hasInlineFk = v3Columns[ent.table] && v3Columns[ent.table].has(attrName);

        let sql = null;
        if (joinCandidate) {
          // Detect the v3 owner/target columns on the V3 side: v3 names them
          // after the singular CT (sometimes hyphenated, e.g. `activity-type_id`).
          const joinCols = [...v3Columns[joinCandidate]].filter((c) => c.endsWith('_id'));
          const v3OwnerCandidates = [
            `${singularName}_id`,
            `${singularName.replace(/_/g, '-')}_id`,
            ...(ent.isComp ? ['component_id'] : []),
          ];
          const v3OwnerCol = v3OwnerCandidates.find((c) => joinCols.includes(c));
          const v3TargetCol = joinCols.find((c) => c !== v3OwnerCol);
          if (v3OwnerCol && v3TargetCol) {
            sql =
              `INSERT INTO \`${TO}\`.\`${v5Lnk}\` (\`${ownerCol}\`, \`${targetCol}\`) ` +
              `SELECT \`${v3OwnerCol}\`, \`${v3TargetCol}\` FROM \`${FROM}\`.\`${joinCandidate}\` ` +
              `WHERE \`${v3OwnerCol}\` IS NOT NULL AND \`${v3TargetCol}\` IS NOT NULL`;
          }
        } else if (hasInlineFk) {
          sql =
            `INSERT INTO \`${TO}\`.\`${v5Lnk}\` (\`${ownerCol}\`, \`${targetCol}\`) ` +
            `SELECT id, \`${attrName}\` FROM \`${FROM}\`.\`${ent.table}\` WHERE \`${attrName}\` IS NOT NULL`;
        }
        if (!sql) continue;

        if (DRY) {
          stats.relations.push(v5Lnk);
        } else {
          await conn.query(`TRUNCATE TABLE \`${TO}\`.\`${v5Lnk}\``);
          await q(conn, sql);
        }
      }
    }

    // ── 5. Uploads: upload_file -> files; upload_file_morph -> files_related_mph ──
    if (!ONLY || ONLY.includes('upload')) {
      if (v3TableNames.has('upload_file')) {
        const [v5c] = await conn.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = 'files'`,
          [TO],
        );
        const v5Cols = new Set(v5c.map((r) => r.COLUMN_NAME));
        const v3Cols = v3Columns['upload_file'];
        const map = [
          ['id', 'id'],
          ['name', 'name'],
          ['alternativeText', 'alternative_text'],
          ['caption', 'caption'],
          ['width', 'width'],
          ['height', 'height'],
          ['formats', 'formats'],
          ['hash', 'hash'],
          ['ext', 'ext'],
          ['mime', 'mime'],
          ['size', 'size'],
          ['url', 'url'],
          ['previewUrl', 'preview_url'],
          ['provider', 'provider'],
          ['provider_metadata', 'provider_metadata'],
          ['created_at', 'created_at'],
          ['updated_at', 'updated_at'],
        ].filter(([a, b]) => v3Cols.has(a) && v5Cols.has(b));

        const insertCols = ['document_id', 'folder_path', ...map.map(([, b]) => b)];
        const selectParts = ['UUID()', "'/'", ...map.map(([a]) => `\`${a}\``)];
        const sql =
          `INSERT INTO \`${TO}\`.\`files\` (${insertCols.map((c) => `\`${c}\``).join(', ')}) ` +
          `SELECT ${selectParts.join(', ')} FROM \`${FROM}\`.upload_file`;
        if (DRY) {
          console.log(`[dry] files: ${map.length} cols from upload_file`);
        } else {
          await conn.query(`TRUNCATE TABLE \`${TO}\`.\`files\``);
          const [res] = await q(conn, sql);
          stats.copied.push({ table: 'files', rows: res.affectedRows });
        }

        // upload_file_morph -> files_related_mph
        if (v3TableNames.has('upload_file_morph')) {
          const morphSql =
            `INSERT INTO \`${TO}\`.\`files_related_mph\` (file_id, related_id, related_type, field) ` +
            `SELECT upload_file_id, related_id, related_type, field FROM \`${FROM}\`.upload_file_morph`;
          if (!DRY) {
            await q(conn, `TRUNCATE TABLE \`${TO}\`.\`files_related_mph\``);
            await q(conn, morphSql);
          } else {
            console.log('[dry] files_related_mph');
          }
        }
      }
    }

    // ── 6. Users (users-permissions_user: same table name both sides) ──────
    if ((!ONLY || ONLY.includes('user')) && v3TableNames.has('users-permissions_user')) {
      const [v5c] = await conn.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = 'users-permissions_user'`,
        [TO],
      );
      const v5Cols = new Set(v5c.map((r) => r.COLUMN_NAME));
      const v3Cols = v3Columns['users-permissions_user'];
      // Scalar user columns (role is a relation -> lnk)
      const userScalars = [
        'id', 'username', 'email', 'provider', 'password', 'resetPasswordToken',
        'confirmationToken', 'confirmed', 'blocked', 'hidden', 'cost_by_hour',
        'monthly_salary', 'monthly_tax', 'ical', 'excel_decimal', 'fullname',
        'identity_number', 'naf', 'multidelivery_discount', 'created_at', 'updated_at',
      ].filter((c) => v3Cols.has(c) && v5Cols.has(c));
      const sql =
        `INSERT INTO \`${TO}\`.\`users-permissions_user\` (document_id, ${userScalars.map((c) => `\`${c}\``).join(', ')}) ` +
        `SELECT UUID(), ${userScalars.map((c) => `\`${c}\``).join(', ')} FROM \`${FROM}\`.\`users-permissions_user\``;
      if (DRY) {
        console.log(`[dry] users: ${userScalars.length} cols`);
      } else {
        await conn.query(`TRUNCATE TABLE \`${TO}\`.\`users-permissions_user\``);
        const [res] = await q(conn, sql);
        stats.copied.push({ table: 'users-permissions_user', rows: res.affectedRows });
        // user role links (v3 inline role column -> v5 lnk)
        if (v3Cols.has('role')) {
          const roleSql =
            `INSERT INTO \`${TO}\`.\`users_permissions_user_role_lnk\` (user_id, role_id) ` +
            `SELECT id, role FROM \`${FROM}\`.\`users-permissions_user\` WHERE role IS NOT NULL`;
          const [lnkExists] = await conn.query(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name = 'users_permissions_user_role_lnk'`,
            [TO],
          );
          if (lnkExists.length) await conn.query(roleSql);
        }
      }
    }
  } finally {
    if (!DRY) await conn.query(`SET FOREIGN_KEY_CHECKS=1`);
    await conn.end();
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const totalRows = stats.copied.reduce((s, c) => s + c.rows, 0);
  console.log(`\n──── ETL ${DRY ? '(dry run)' : 'COMPLETE'} ────`);
  console.log(`Core tables copied: ${stats.copied.length} (${totalRows} rows)`);
  console.log(`Component rows: ${stats.components}`);
  console.log(`Skipped (missing in v3): ${stats.skippedMissing.length}`);
  if (DRY) console.log(`Relation lnk tables (dry): ${stats.relations.length}`);
  if (!DRY) {
    for (const c of stats.copied.sort((a, b) => b.rows - a.rows).slice(0, 15)) {
      console.log(`  ${c.table}: ${c.rows}`);
    }
  }
}

async function q(conn, sql) {
  try {
    return await conn.query(sql);
  } catch (e) {
    console.error('SQL FAILED:', sql);
    throw e;
  }
}

main().catch((e) => {
  console.error('ETL FAILED:', e.message);
  process.exit(1);
});
