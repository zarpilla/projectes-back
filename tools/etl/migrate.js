'use strict';

// Connection details come from .env, the same file the app uses.
require('dotenv').config();

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

/**
 * Pairs a v5 column with the v3 column holding the same data.
 *
 * Strapi derives the column name from the attribute name, and its snake_case
 * splits digit groups and camelCase words that Bookshelf stored verbatim:
 *
 *     face_dir3_oc  -> face_dir_3_oc      costByHour -> cost_by_hour
 *     less15        -> less_15            from10to20 -> from_10_to_20
 *
 * Matching on the exact string therefore skipped those columns without a word
 * of warning. That is how the FACe DIR3 codes and every price in route_rates
 * were dropped. Compare with separators removed, and select the v3 column into
 * the v5 one.
 */
const squash = (name) => name.replace(/_/g, '').toLowerCase();

// Compares text across the v3 and v5 databases.
//
// The two schemas do not agree on collation, and it varies per tenant: every
// v3 database defaults to utf8mb4_0900_ai_ci and every v5 one to
// utf8mb4_unicode_ci, but what MySQL actually uses is the COLUMN collation.
// Most tenants happen to have strapi_role.code in utf8mb4_unicode_ci, so the
// join worked; resilience has it in utf8mb4_0900_ai_ci and the cutover died
// with "Illegal mix of collations ... for operation '='".
//
// CONVERT() first, so this also holds for a column that is not utf8mb4 at all
// (applying COLLATE utf8mb4_* directly to a latin1 column is an error).
const sameText = (a, b) =>
  `CONVERT(${a} USING utf8mb4) COLLATE utf8mb4_unicode_ci = ` +
  `CONVERT(${b} USING utf8mb4) COLLATE utf8mb4_unicode_ci`;

function pairColumns(names, v3Cols, v5Cols) {
  const index = (cols) => {
    const map = new Map();
    // First wins, so an exact name is never displaced by a squashed one.
    for (const col of cols) if (!map.has(squash(col))) map.set(squash(col), col);
    return map;
  };
  const v3Index = index(v3Cols);
  const v5Index = index(v5Cols);

  const pairs = [];
  const seen = new Set();
  // `names` may be written in either spelling — the schema-derived lists use
  // v5 attribute names, the hand-written user list uses v3 column names — so
  // resolve both ends rather than assuming one side matches exactly.
  for (const name of names) {
    const key = squash(name);
    const to = v5Cols.has(name) ? name : v5Index.get(key);
    const from = v3Cols.has(name) ? name : v3Index.get(key);
    if (!to || !from || seen.has(to)) continue;
    seen.add(to);
    pairs.push({ to, from });
  }
  return pairs;
}

async function main() {
  const { contentTypes, components } = loadRegistry();
  // uid -> collectionName, so a relation can be traced from its OTHER side:
  // v3 named a M2M join table after whichever side was `dominant`, which is not
  // always the side that owns the v5 link table.
  const tableByUid = Object.fromEntries(contentTypes.map((c) => [c.uid, c.table]));
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

  const stats = { copied: [], skippedMissing: [], relations: [], relationsNoSource: [], components: 0, warnings: [] };

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

      // `published_at` is now a declared attribute on the types that used Draft &
      // Publish, so it can already be among the scalars — pairColumns dedupes,
      // or MySQL rejects the INSERT with "Column 'published_at' specified twice".
      const pairs = pairColumns(
        ['id', ...scalarAttrs, 'created_at', 'updated_at', 'published_at'],
        v3Cols,
        v5Cols,
      );
      const colList = pairs.map((p) => p.to);
      const selectExprs = pairs.map((p) => (p.to === 'id' ? 'id' : `\`${p.from}\``));
      // v3 kept the live/trashed state in `published_at` (null = trashed). v5
      // owns that column, so the five formerly Draft & Publish types carry a
      // `trashed` boolean instead — derive it here.
      if (v5Cols.has('trashed') && !v3Cols.has('trashed') && v3Cols.has('published_at')) {
        colList.push('trashed');
        selectExprs.push('(`published_at` IS NULL)');
      }
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
      const pairs = pairColumns(['id', ...scalarAttrs], v3Cols, v5Cols);
      const colList = pairs.map((p) => p.to);
      if (!colList.includes('id')) continue;

      const sql =
        `INSERT INTO \`${TO}\`.\`${comp.table}\` (${colList.map((c) => `\`${c}\``).join(', ')}) ` +
        `SELECT ${pairs.map((p) => `\`${p.from}\``).join(', ')} FROM \`${FROM}\`.\`${comp.table}\``;
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

        // v3 source A: the M2M join table. v3 used three shapes, and only the
        // first was recognised before — the other two left the relation empty:
        //   1. <table>_<attr>__<otherTable>_<otherAttr>   (this side dominant)
        //   2. <otherTable>_<otherAttr>__<table>_<attr>   (other side dominant)
        //   3. <table>__<attr>                            (no `via` on the other side)
        const inverseAttr = def.mappedBy || def.inversedBy;
        const targetTable = def.target ? tableByUid[def.target] : undefined;
        const joinPrefixes = [`${ent.table}_${attrName}__`];
        if (inverseAttr && targetTable) joinPrefixes.push(`${targetTable}_${inverseAttr}__`);
        let joinCandidate = null;
        for (const prefix of joinPrefixes) {
          joinCandidate = [...v3TableNames].find((t) => t.startsWith(prefix));
          if (joinCandidate) break;
        }
        if (!joinCandidate && v3TableNames.has(`${ent.table}__${attrName}`)) {
          joinCandidate = `${ent.table}__${attrName}`;
        }
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
        if (!sql) {
          stats.relationsNoSource.push(v5Lnk);
          continue;
        }

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
          // related_id must fit v5's INT UNSIGNED: skip orphan/corrupt morph
          // rows (some tenants carry related_id = -1 pointing at nothing).
          // v3 stored `related_type` as the model/table name ("us",
          // "received_expenses"); v5 wants the content-type UID
          // ("api::me.me"). Copying it verbatim leaves every attachment
          // orphaned: the media relation resolves to null, so invoice logos,
          // certificates and expense documents all silently disappear.
          const tableToUid = new Map();
          for (const ct of contentTypes) {
            if (ct.table && ct.uid) tableToUid.set(ct.table, ct.uid);
          }
          const caseArms = [...tableToUid.entries()]
            .map(([table, uid]) => `WHEN ${conn.escape(table)} THEN ${conn.escape(uid)}`)
            .join(' ');
          const relatedTypeExpr = caseArms
            ? `CASE related_type ${caseArms} ELSE related_type END`
            : 'related_type';

          const morphSql =
            `INSERT INTO \`${TO}\`.\`files_related_mph\` (file_id, related_id, related_type, field) ` +
            `SELECT upload_file_id, related_id, ${relatedTypeExpr}, field FROM \`${FROM}\`.upload_file_morph ` +
            `WHERE related_id IS NOT NULL AND related_id > 0`;
          if (!DRY) {
            await q(conn, `TRUNCATE TABLE \`${TO}\`.\`files_related_mph\``);
            await q(conn, morphSql);
            const [unmapped] = await conn.query(
              `SELECT related_type, COUNT(*) n FROM \`${TO}\`.\`files_related_mph\` ` +
                `WHERE related_type NOT LIKE 'api::%' AND related_type NOT LIKE 'plugin::%' ` +
                `GROUP BY related_type`,
            );
            for (const row of unmapped) {
              stats.warnings.push(
                `files_related_mph: ${row.n} row(s) still point at "${row.related_type}" — ` +
                  `no v5 content type uses that table, so those attachments stay unlinked`,
              );
            }
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
      const userPairs = pairColumns(
        [
        'id', 'username', 'email', 'provider', 'password', 'resetPasswordToken',
        'confirmationToken', 'confirmed', 'blocked', 'hidden', 'cost_by_hour',
        'monthly_salary', 'monthly_tax', 'ical', 'excel_decimal', 'fullname',
        'identity_number', 'naf', 'multidelivery_discount', 'created_at', 'updated_at',
      ],
        v3Cols,
        v5Cols,
      );
      const userScalars = userPairs.map((p) => p.to);
      const sql =
        `INSERT INTO \`${TO}\`.\`users-permissions_user\` (document_id, ${userScalars.map((c) => `\`${c}\``).join(', ')}) ` +
        `SELECT UUID(), ${userPairs.map((p) => `\`${p.from}\``).join(', ')} FROM \`${FROM}\`.\`users-permissions_user\``;
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
          if (lnkExists.length) {
            // TRUNCATE first, like every other table — the ETL is meant to be
            // re-runnable and the lnk table has a (user, role) unique key.
            await conn.query(`TRUNCATE TABLE \`${TO}\`.\`users_permissions_user_role_lnk\``);
            const [lnkRes] = await q(conn, roleSql);
            stats.copied.push({ table: 'users_permissions_user_role_lnk', rows: lnkRes.affectedRows });
          } else {
            // Silently skipping this used to leave every migrated user role-less,
            // which 401s the whole content API (the auth strategy reads
            // user.role.id). Fail loudly instead — a missing link table means the
            // v5 schema was not generated, or the user.role relation is declared
            // on the non-owning side.
            throw new Error(
              `${TO}.users_permissions_user_role_lnk is missing — boot the v5 app once against ${TO} to generate the schema before migrating users`,
            );
          }
        }
      }
    }

    // ── 7. Admin panel accounts (strapi_administrator -> admin_users) ──────
    // Without this a migrated tenant has no admin at all and the panel sends
    // you to /admin/auth/register-admin. The API users above are a different
    // table and a different login, so they do not help. v3 and v5 both store
    // bcrypt, and both name the roles strapi-super-admin / -editor / -author,
    // so the accounts carry over with their existing passwords.
    if ((!ONLY || ONLY.includes('admin')) && v3TableNames.has('strapi_administrator')) {
      const [v5c] = await conn.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = 'admin_users'`,
        [TO],
      );
      const v5Cols = new Set(v5c.map((r) => r.COLUMN_NAME));
      const v3Cols = v3Columns['strapi_administrator'];
      // isActive -> is_active, resetPasswordToken -> reset_password_token, …
      const pairs = pairColumns(['id', ...v3Cols], v3Cols, v5Cols);

      const sql =
        `INSERT INTO \`${TO}\`.\`admin_users\` (document_id, ${pairs.map((p) => `\`${p.to}\``).join(', ')}) ` +
        `SELECT UUID(), ${pairs.map((p) => `\`${p.from}\``).join(', ')} FROM \`${FROM}\`.\`strapi_administrator\``;

      if (DRY) {
        console.log(`[dry] admin_users: ${pairs.length} cols from strapi_administrator`);
      } else {
        await conn.query(`TRUNCATE TABLE \`${TO}\`.\`admin_users_roles_lnk\``);
        await conn.query(`TRUNCATE TABLE \`${TO}\`.\`admin_users\``);
        const [res] = await q(conn, sql);
        stats.copied.push({ table: 'admin_users', rows: res.affectedRows });

        // Roles are matched by CODE: both versions bootstrap their own rows, so
        // the ids are not guaranteed to line up even though they usually do.
        if (v3TableNames.has('strapi_users_roles') && v3TableNames.has('strapi_role')) {
          const roleSql =
            `INSERT INTO \`${TO}\`.\`admin_users_roles_lnk\` (user_id, role_id) ` +
            `SELECT ur.user_id, r5.id FROM \`${FROM}\`.\`strapi_users_roles\` ur ` +
            `JOIN \`${FROM}\`.\`strapi_role\` r3 ON r3.id = ur.role_id ` +
            `JOIN \`${TO}\`.\`admin_roles\` r5 ON ${sameText('r5.code', 'r3.code')} ` +
            `JOIN \`${TO}\`.\`admin_users\` u5 ON u5.id = ur.user_id`;
          const [lnkRes] = await q(conn, roleSql);
          stats.copied.push({ table: 'admin_users_roles_lnk', rows: lnkRes.affectedRows });

          const [orphans] = await conn.query(
            `SELECT COUNT(*) n FROM \`${TO}\`.\`admin_users\` u ` +
              `LEFT JOIN \`${TO}\`.\`admin_users_roles_lnk\` l ON l.user_id = u.id ` +
              `WHERE l.user_id IS NULL`,
          );
          if (orphans[0].n > 0) {
            stats.warnings.push(
              `admin_users: ${orphans[0].n} account(s) have no role and cannot sign in to the panel`,
            );
          }
        } else {
          stats.warnings.push(
            'admin_users copied but v3 has no strapi_users_roles/strapi_role — the accounts have no role and cannot sign in',
          );
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
  if (stats.relationsNoSource.length) {
    // Not necessarily wrong — a v5-only relation has no v3 source — but this is
    // where silently-unmigrated relations show up, so print it.
    console.log(
      `Relations with a v5 link table but no v3 source: ${stats.relationsNoSource.length}`,
    );
  }
  console.log(`Component rows: ${stats.components}`);
  console.log(`Skipped (missing in v3): ${stats.skippedMissing.length}`);
  if (stats.warnings.length) {
    console.log(`\nWarnings (${stats.warnings.length}):`);
    for (const warning of stats.warnings) console.log(`  ! ${warning}`);
  }
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
