'use strict';

/**
 * The resilience cutover died in the admin-users step with
 *   Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT)
 *   and (utf8mb4_0900_ai_ci,IMPLICIT) for operation '='
 * on `JOIN admin_roles r5 ON r5.code = r3.code`.
 *
 * Collation varies per tenant at the COLUMN level: most tenants have
 * strapi_role.code in utf8mb4_unicode_ci (matching what Strapi 5 creates), but
 * resilience has it in utf8mb4_0900_ai_ci, so the cross-database comparison is
 * an illegal mix. 13 tenants migrated before this surfaced.
 *
 * The behaviour was verified against a real MySQL 8.4: the bare comparison
 * raises ERROR 1267 and the coerced one links the row. This test guards the
 * SQL shape so the coercion cannot be dropped by a later edit.
 */

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'tools', 'etl', 'migrate.js'),
  'utf8'
);

/** Pulls `sameText` out of the ETL without booting it. */
function loadSameText() {
  const start = source.indexOf('const sameText =');
  const end = source.indexOf('function pairColumns');
  // eslint-disable-next-line no-new-func
  return new Function(`${source.slice(start, end)}; return sameText;`)();
}

describe('cross-database text comparison', () => {
  const sameText = loadSameText();

  it('pins both sides to one collation', () => {
    const sql = sameText('r5.code', 'r3.code');
    expect(sql).toBe(
      'CONVERT(r5.code USING utf8mb4) COLLATE utf8mb4_unicode_ci = ' +
        'CONVERT(r3.code USING utf8mb4) COLLATE utf8mb4_unicode_ci'
    );
  });

  it('converts first, so a non-utf8mb4 column is handled too', () => {
    // COLLATE utf8mb4_* applied straight to a latin1 column is an error,
    // so the CONVERT has to come before the COLLATE on each side.
    const sql = sameText('a.x', 'b.y');
    for (const side of ['a.x', 'b.y']) {
      expect(sql).toContain(`CONVERT(${side} USING utf8mb4) COLLATE utf8mb4_unicode_ci`);
    }
  });

  it('is what the admin role link join actually uses', () => {
    expect(source).toContain(
      "JOIN \\`${TO}\\`.\\`admin_roles\\` r5 ON ${sameText('r5.code', 'r3.code')}"
    );
    // the bare comparison must not come back
    expect(source).not.toContain('r5.code = r3.code');
  });
});
