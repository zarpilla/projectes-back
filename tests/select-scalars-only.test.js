'use strict';

/**
 * `select` / `fields` may name SCALAR attributes only.
 *
 * v3 stored a oneToOne/manyToOne relation as an FK column on the row, so
 * `select: ['id', 'name', 'project_type']` was valid SQL. v5 moves every
 * relation into a `<table>_<attr>_lnk` join table, so the same list compiles to
 * `select t0.project_type`, and MySQL answers:
 *
 *     Unknown column 't0.project_type' in 'field list'
 *
 * That 500'd `GET /api/projects/dedications`, which is the whole
 * /stats-previsio-gantt page. The relation still has to be requested — but
 * through `populate`, not `select`.
 *
 * This walks every `select:`/`fields:` array literal under src/ and fails on any
 * name that is a relation, component, media or dynamiczone on ANY content type.
 * Matching across all types rather than resolving the uid per call site is
 * deliberate: it costs a few false positives in exchange for needing no data
 * flow analysis, and no scalar in this schema shares a name with a relation.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const API_DIR = path.join(SRC, 'api');
const NON_SCALAR = ['relation', 'component', 'media', 'dynamiczone'];

/** Every attribute name that is not a plain column, across all content types. */
function nonScalarAttributeNames() {
  const names = new Set();
  for (const api of fs.readdirSync(API_DIR)) {
    const ctDir = path.join(API_DIR, api, 'content-types');
    if (!fs.existsSync(ctDir)) continue;
    for (const ct of fs.readdirSync(ctDir)) {
      const file = path.join(ctDir, ct, 'schema.json');
      if (!fs.existsSync(file)) continue;
      const attributes = JSON.parse(fs.readFileSync(file, 'utf8')).attributes || {};
      for (const [name, def] of Object.entries(attributes)) {
        if (def && NON_SCALAR.includes(def.type)) names.add(name);
      }
    }
  }
  return names;
}

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const SELECT_LIST = /\b(?:select|fields)\s*:\s*\[([^\]]*)\]/g;

describe('select / fields lists', () => {
  it('name scalar columns only, never relations', () => {
    const nonScalar = nonScalarAttributeNames();
    expect(nonScalar.size).toBeGreaterThan(0); // the schema loaded

    const offenders = [];
    for (const file of jsFiles(SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      let match;
      SELECT_LIST.lastIndex = 0;
      while ((match = SELECT_LIST.exec(source)) !== null) {
        const named = match[1]
          .split(',')
          .map((s) => s.trim().replace(/^['"`]|['"`]$/g, ''))
          .filter(Boolean);
        const bad = named.filter((n) => nonScalar.has(n));
        if (bad.length) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${path.relative(SRC, file)}:${line} selects ${bad.join(', ')}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
