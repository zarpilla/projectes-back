'use strict';
/* global strapi */

/**
 * v3 and v5 spell `component_type` differently in the component join tables.
 *
 * v3 stored the component's table name (`components_invoice_line_ticket_lines`),
 * v5 stores its UID (`invoice-line.ticket-line`). The ETL copied the v3 value
 * as is, and v5 only manages join rows that carry the UID:
 *
 *   - populate reads every row of the field, whatever its component_type, so a
 *     migrated line is shown once per spelling;
 *   - a save that re-links the lines writes UID rows next to the legacy ones and
 *     never deletes the legacy ones.
 *
 * So after the first such save every migrated line showed twice, and deleting
 * the copy brought it back on the next load (issue 002: a received income's
 * single 6,452.80 line showed as two, the form total doubled).
 *
 * For every `*_cmps` table: drop the legacy rows that already have a UID twin
 * (the UID row is the one v5 keeps up to date), then rename the rest to the UID.
 *
 * Idempotent and cheap once applied (one DISTINCT per table), so it runs on
 * every boot: a tenant rebuilt by an older ETL gets repaired too.
 */
const { rawExecute } = require('./raw-sql');

const affected = (res) => (res && typeof res === 'object' ? res.affectedRows || 0 : Number(res) || 0);

async function normalizeComponentTypes() {
  const uidByTable = new Map();
  for (const [uid, component] of Object.entries(strapi.components)) {
    if (component.collectionName) uidByTable.set(component.collectionName, uid);
  }

  const tables = await rawExecute(
    strapi,
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ?`,
    ['%\\_cmps'],
  );

  for (const { name: table } of tables) {
    const types = await rawExecute(strapi, `SELECT DISTINCT component_type AS type FROM \`${table}\``, []);
    for (const { type } of types) {
      if (!type || strapi.components[type]) continue;
      const uid = uidByTable.get(type);
      if (!uid) {
        strapi.log.warn(`[COMPONENT TYPES] ${table}: unknown component_type "${type}" left as is`);
        continue;
      }

      const deleted = affected(
        await rawExecute(
          strapi,
          `DELETE legacy FROM \`${table}\` legacy
             JOIN \`${table}\` current
               ON current.entity_id = legacy.entity_id
              AND current.cmp_id = legacy.cmp_id
              AND current.field = legacy.field
              AND current.component_type = ?
            WHERE legacy.component_type = ?`,
          [uid, type],
        ),
      );
      const renamed = affected(
        await rawExecute(strapi, `UPDATE \`${table}\` SET component_type = ? WHERE component_type = ?`, [uid, type]),
      );
      strapi.log.info(
        `[COMPONENT TYPES] ${table}: ${type} -> ${uid} (${deleted} duplicate link(s) removed, ${renamed} renamed)`,
      );
    }
  }
}

module.exports = { normalizeComponentTypes };
