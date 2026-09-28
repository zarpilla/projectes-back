'use strict';

/**
 * Creating a collection order returned 500:
 *
 *   Unknown column 't0.status_nin' in 'where clause'
 *   ... where (`t0`.`is_collection_order` = true and ...
 *       and `t0`.`status_nin` in ('cancelled','invoiced')
 *       and `t0`.`_sort` = 'id:ASC')
 *
 * v3's Bookshelf query layer accepted flat operator suffixes (`status_nin`,
 * `id_in`, `published_at_null`) and query params (`_sort`, `_limit`) inside the
 * same object as real columns. v5's db.query does not: anything it does not
 * recognise is treated as a column name, so these reach MySQL verbatim and the
 * query dies. Nothing catches it at boot — only the request fails.
 *
 * Four sites in the order lifecycles and one in projectFinancials carried the
 * v3 spelling. This scans for the whole class rather than those five, because
 * the failure is invisible until the specific code path runs.
 *
 * The legitimate places to write v3 spellings are:
 *   - services/query-adapter.js, which exists to translate them
 *   - a call that hands the object to adaptQuery()
 *   - reading them off ctx.query, which is what the v3 frontend still sends
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

function jsFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) jsFiles(full, found);
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

// `foo_nin:` / `bar_in:` / `x_null:` — an operator suffix used as an object key.
const FLAT_OPERATOR = /\b[a-z][a-z0-9_]*_(ne|nin|in|gt|gte|lt|lte|contains|ncontains|null|eq)\s*:/;
// v3 query params used as object keys.
const V3_PARAM = /(?:^|[{,\s])(_sort|_limit|_start|_where|_q)\s*:/;

// Statements inside createPhasesForAllProjects, which is dead: the function
// opens with an unconditional `return;` ("Disabled in v3; the ETL handles phase
// creation") and carries eslint-disable no-unreachable. Left as found rather
// than rewritten, because a `delete()` with no `where` is worth nobody making
// executable by accident. Matched on text so it survives line moves.
const KNOWN_DEAD = [
  "await strapi.db.query('api::estimated-hour.estimated-hour').delete({ _limit: -1 });",
  "await strapi.db.query('api::phase-income.phase-income').delete({ _limit: -1 });",
  "await strapi.db.query('api::phase-expense.phase-expense').delete({ _limit: -1 });",
  "await strapi.db.query('api::project-phase.project-phase').delete({ _limit: -1 });",
  "await strapi.db.query('api::project-original-phase.project-original-phase').delete({ _limit: -1 });",
];

/** Identifiers this file later hands to adaptQuery() — those are translated. */
function adapterFedNames(source) {
  const names = new Set();
  const re = /adapt(?:Ctx)?Query\(\s*\{?\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(source)) !== null) names.add(m[1]);
  return names;
}

const offenders = [];
for (const file of jsFiles(SRC)) {
  const rel = path.relative(SRC, file);
  if (rel === path.join('services', 'query-adapter.js')) continue;

  const source = fs.readFileSync(file, 'utf8');
  const fed = adapterFedNames(source);
  source.split('\n').forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith('//') || code.startsWith('*')) return;
    if (KNOWN_DEAD.includes(code)) return;
    // handed to the adapter on this line -> translated, fine
    if (line.includes('adaptQuery') || line.includes('adaptCtxQuery')) return;
    // reading what the v3 frontend sent, rather than building a query
    if (line.includes('ctx.query') || line.includes('query._')) return;
    // assigning to / extending an object that reaches adaptQuery later
    const assigned = code.match(/^(?:const|let|var)?\s*([A-Za-z_$][\w$]*)(?:\.[\w$]+)?\s*=/);
    if (assigned && fed.has(assigned[1])) return;

    if (FLAT_OPERATOR.test(line) || V3_PARAM.test(line)) {
      offenders.push(`${rel}:${i + 1}  ${code.slice(0, 100)}`);
    }
  });
}

describe('v3 query spellings must not reach db.query', () => {
  it('finds source to scan — guards the walk above', () => {
    expect(jsFiles(SRC).length).toBeGreaterThan(50);
  });

  it('no flat operator or v3 param is used as a query key', () => {
    expect(offenders).toEqual([]);
  });
});

describe('order lifecycles collection-order queries', () => {
  const source = fs.readFileSync(
    path.join(SRC, 'api', 'order', 'content-types', 'order', 'lifecycles.js'),
    'utf8'
  );

  it('uses $notIn instead of the v3 status_nin', () => {
    expect(source).not.toMatch(/status_nin\s*:/);
    expect(source).toContain('status: { $notIn: CLOSED_STATUSES }');
  });

  it('sorts via orderBy, not a _sort key inside where', () => {
    expect(source).not.toMatch(/_sort\s*:/);
    expect(source).toContain("orderBy: { id: 'asc' }");
  });

  it('declares the closed statuses once, so the call sites cannot drift', () => {
    expect(source).toContain("const CLOSED_STATUSES = ['cancelled', 'invoiced'];");
    // four query sites reference it
    expect(source.match(/CLOSED_STATUSES/g).length).toBeGreaterThanOrEqual(5);
  });

  it('filters route ids with $in', () => {
    expect(source).not.toMatch(/id_in\s*:/);
    expect(source).toContain('id: { $in: routeIds }');
  });
});
