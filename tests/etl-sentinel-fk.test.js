'use strict';

/**
 * The CSV import rejected contacts with "no te sector" although they had one.
 *
 * The check tested `legal_form`, and v5 resolved it to null for 830 of
 * diligencia's contacts. The cause is in the ETL: v3 wrote 0 into an FK column
 * to mean "unset" (833 contacts had legal_form = 0, against 19 with a real
 * id), and the link-table build filtered only on IS NOT NULL. So 0 was copied
 * through and became a link row pointing at legal_form_id = 0 — a row that does
 * not exist, since legal_forms only has ids 1 and 2.
 *
 * In v5 "no value" is the absence of a link, so the filter has to be `> 0`.
 * A link to a nonexistent row is worse than no link: it populates as null
 * anyway, but it makes the data claim a relation it does not have.
 */

const fs = require('fs');
const path = require('path');

const raw = fs.readFileSync(
  path.join(__dirname, '..', 'tools', 'etl', 'migrate.js'),
  'utf8'
);
// The SQL is built in template literals, so every backtick is escaped on disk.
// Unescape once so the assertions can be written the way the code reads.
const source = raw.replace(/\\`/g, '`');

/** The two statements that fill a *_lnk table. */
function linkInserts() {
  return source
    .split('\n')
    .filter((l) => l.includes('FROM `${FROM}`') && (l.includes('${attrName}') || l.includes('${v3TargetCol}')));
}

describe('link tables built from v3 FK columns', () => {
  it('finds both build paths — guards the extraction', () => {
    expect(linkInserts().length).toBe(2);
  });

  it('the inline FK path skips the v3 sentinel 0', () => {
    const inline = source.slice(source.indexOf('} else if (hasInlineFk) {'));
    expect(inline).toContain('`${attrName}` > 0');
    expect(inline).not.toContain('`${attrName}` IS NOT NULL`');
  });

  it('the join-table path skips 0 on both sides', () => {
    expect(source).toContain('`${v3OwnerCol}` > 0 AND `${v3TargetCol}` > 0');
  });

  it('no link insert filters on IS NOT NULL alone any more', () => {
    for (const line of linkInserts()) {
      expect(line).not.toMatch(/IS NOT NULL/);
    }
  });

  it('`> 0` also excludes NULL, so nothing valid is lost', () => {
    // documents the reasoning: in SQL, NULL > 0 is NULL, which is not true,
    // so the stricter predicate is a superset of the old one.
    const rows = [null, 0, 1, 42];
    const oldKeep = rows.filter((v) => v !== null);
    const newKeep = rows.filter((v) => v !== null && v > 0);
    expect(oldKeep).toEqual([0, 1, 42]);
    expect(newKeep).toEqual([1, 42]);
  });
});
