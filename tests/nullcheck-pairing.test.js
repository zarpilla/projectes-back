'use strict';

/**
 * The resilience cutover aborted with
 *   !! LOST VALUES (v3 populated, v5 NULL) — 1 column(s):
 *      users-permissions_user.costbyhour (renamed to cost_by_hour): 9/44 lost
 * on a tenant whose data had in fact copied correctly.
 *
 * Its v3 user table carries two columns: `costbyhour`, a fossil from an older
 * schema that the v3 app does not read (the v3 model declares cost_by_hour,
 * and that file is identical across tenants), and the live `cost_by_hour`.
 * v5 has only `cost_by_hour`. squash() collapses both v3 names to the same
 * key, so the single-pass pairing let whichever column MySQL happened to
 * return first claim the v5 column. The fossil won and the live column was
 * dropped from the audit.
 */

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'tools', 'etl', 'nullcheck.js'),
  'utf8'
);

/** Pulls `squash` + `pairForAudit` out of the audit script without booting it. */
function loadPairing() {
  const start = source.indexOf('const squash =');
  const marker = '  return pairs;\n}';
  const end = source.indexOf(marker) + marker.length;
  const src = source.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return { squash, pairForAudit };`)();
}

const { squash, pairForAudit } = loadPairing();

const pair = (v3, v5) => {
  const v5Cols = new Set(v5);
  const v5BySquash = new Map();
  for (const c of v5Cols) if (!v5BySquash.has(squash(c))) v5BySquash.set(squash(c), c);
  return pairForAudit(new Set(v3), v5Cols, v5BySquash);
};

describe('null-audit column pairing', () => {
  const V5 = ['id', 'username', 'cost_by_hour'];

  it('pairs the live column, not the fossil — either column order', () => {
    for (const v3 of [
      ['id', 'username', 'costbyhour', 'cost_by_hour'],
      ['id', 'username', 'cost_by_hour', 'costbyhour'],   // the order that broke it
    ]) {
      const pairs = pair(v3, V5);
      expect(pairs).toContainEqual({ from: 'cost_by_hour', to: 'cost_by_hour' });
      expect(pairs.map((p) => p.from)).not.toContain('costbyhour');
    }
  });

  it('never maps two v3 columns onto one v5 column', () => {
    const pairs = pair(['id', 'costbyhour', 'cost_by_hour'], V5);
    const targets = pairs.map((p) => p.to);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('still pairs a genuinely renamed column when there is no exact match', () => {
    const pairs = pair(['id', 'costByHour'], V5);
    expect(pairs).toContainEqual({ from: 'costByHour', to: 'cost_by_hour' });
  });

  it('skips id and columns v5 does not have', () => {
    const pairs = pair(['id', 'username', 'droppedcol'], V5);
    expect(pairs).toEqual([{ from: 'username', to: 'username' }]);
  });
});
