'use strict';

/**
 * The ETL must match v3 columns onto v5 columns Strapi renamed.
 *
 * v3 (Bookshelf) stored the attribute name verbatim as the column name. Strapi
 * v5 derives the column with its own snake_case, which separates digit groups
 * and camelCase words:
 *
 *     face_dir3_oc -> face_dir_3_oc      costByHour -> cost_by_hour
 *     less15       -> less_15            from10to20 -> from_10_to_20
 *     ratev2       -> ratev_2            leadingZeros -> leading_zeros
 *
 * The ETL compared names exactly, so every such column was skipped without a
 * word of warning. That silently dropped the FACe DIR3 codes — which are
 * mandatory to submit an invoice to a public administration — and every price
 * in route_rates, which is what collection orders are billed from.
 *
 * The pairing is exercised through the ETL source so the test cannot drift
 * from the implementation.
 */

const fs = require('fs');
const path = require('path');

/** Pulls `squash` and `pairColumns` out of the ETL without booting it. */
function loadPairing() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'etl', 'migrate.js'), 'utf8');
  const squashSrc = source.slice(source.indexOf('const squash ='), source.indexOf('function pairColumns'));
  const pairSrc = source.slice(source.indexOf('function pairColumns'));
  const body = pairSrc.slice(0, pairSrc.indexOf('\n}\n') + 3);
  // eslint-disable-next-line no-new-func
  return new Function(`${squashSrc}\n${body}\nreturn { squash, pairColumns };`)();
}

const { squash, pairColumns } = loadPairing();

describe('squash', () => {
  it('ignores separator differences only', () => {
    expect(squash('face_dir_3_oc')).toBe(squash('face_dir3_oc'));
    expect(squash('cost_by_hour')).toBe(squash('costByHour'.toLowerCase()));
    expect(squash('less_15')).toBe(squash('less15'));
  });

  it('does not collapse genuinely different names', () => {
    expect(squash('less_15')).not.toBe(squash('less_30'));
    expect(squash('from_10_to_20')).not.toBe(squash('from_20_to_30'));
  });
});

describe('pairColumns', () => {
  const v3 = new Set(['id', 'name', 'face_dir3_oc', 'less15', 'from10to20', 'ratev2', 'leadingZeros', 'costByHour', 'gone_in_v5']);
  const v5 = new Set(['id', 'name', 'face_dir_3_oc', 'less_15', 'from_10_to_20', 'ratev_2', 'leading_zeros', 'cost_by_hour', 'new_in_v5']);

  const pairsFor = (names) => pairColumns(names, v3, v5);
  const toMap = (pairs) => Object.fromEntries(pairs.map((p) => [p.to, p.from]));

  it('pairs the renamed columns the migration lost', () => {
    expect(toMap(pairsFor(['face_dir_3_oc', 'less_15', 'from_10_to_20', 'ratev_2', 'leading_zeros', 'cost_by_hour']))).toEqual({
      face_dir_3_oc: 'face_dir3_oc',
      less_15: 'less15',
      from_10_to_20: 'from10to20',
      ratev_2: 'ratev2',
      leading_zeros: 'leadingZeros',
      cost_by_hour: 'costByHour',
    });
  });

  it('prefers an exact match over a squashed one', () => {
    expect(toMap(pairsFor(['id', 'name']))).toEqual({ id: 'id', name: 'name' });
  });

  it('accepts names written in either spelling', () => {
    // The schema-derived lists use v5 names; the hand-written user list uses v3.
    expect(toMap(pairsFor(['leadingZeros']))).toEqual({ leading_zeros: 'leadingZeros' });
    expect(toMap(pairsFor(['leading_zeros']))).toEqual({ leading_zeros: 'leadingZeros' });
  });

  it('skips columns missing from either side', () => {
    expect(pairsFor(['gone_in_v5'])).toEqual([]);
    expect(pairsFor(['new_in_v5'])).toEqual([]);
  });

  it('emits each target once, so the INSERT cannot name a column twice', () => {
    // `published_at` is both a declared attribute and appended by hand, which
    // MySQL rejects as "Column specified twice".
    const pairs = pairsFor(['name', 'name', 'leading_zeros', 'leadingZeros']);
    const targets = pairs.map((p) => p.to);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('never pairs two different columns onto the same source', () => {
    const pairs = pairsFor(['less_15', 'from_10_to_20']);
    const sources = pairs.map((p) => p.from);
    expect(new Set(sources).size).toBe(sources.length);
  });
});
