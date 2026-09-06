'use strict';

/**
 * Guards the boundary between the REST query shape and the db.query shape.
 *
 * `adaptQuery` answers the REST/Document Service shape — `filters`, `sort`,
 * `pagination`. `strapi.db.query().findMany()` wants `where`, `orderBy`,
 * `limit`, `offset`. Passing the first straight to the second LOOKS like it
 * works, because the db layer does accept a `filters` key — but `filters` is
 * Strapi's *cascading* filter: query-builder pushes it into `where` for the
 * top-level query AND copies it into every populate subquery
 * (`getPopulateValue(populate[attr], qb.state.filters)` in
 * @strapi/database query/helpers/populate/apply). `where` does not cascade.
 *
 * So /api/projects/economic-detail applied the project's own filters to the
 * populated `project_states` rows and 500'd with
 * "Unknown column 't0.trashed' in 'where clause'". `sort` and `pagination`
 * were silently dropped at the same time — the quieter half of one mistake.
 */

const fs = require('fs');
const path = require('path');
const { adaptQuery, toDbArgs, v3FindArgs } = require('../src/services/query-adapter');

describe('toDbArgs', () => {
  it('moves filters to where — never leaves a cascading `filters` key', () => {
    const args = toDbArgs(adaptQuery({ _where: { project_state_in: '1,2,3' } }));
    expect(args.filters).toBeUndefined();
    expect(args.where).toEqual({ project_state: { $in: [1, 2, 3] } });
  });

  it('translates pagination and sort to the db names', () => {
    const args = toDbArgs(adaptQuery({ _limit: '25', _start: '50', _sort: 'name:DESC' }));
    expect(args.limit).toBe(25);
    expect(args.offset).toBe(50);
    expect(args.orderBy).toEqual([{ name: 'desc' }]);
    expect(args.pagination).toBeUndefined();
    expect(args.sort).toBeUndefined();
  });

  it('leaves limit unset for the v3 "all rows" sentinel', () => {
    const args = toDbArgs(adaptQuery({ _limit: '-1' }));
    expect(args.limit).toBeUndefined();
  });

  it('takes an explicit populate over the one on the opts', () => {
    const opts = adaptQuery({}, { populate: { a: true } });
    expect(toDbArgs(opts).populate).toEqual({ a: true });
    expect(toDbArgs(opts, { b: true }).populate).toEqual({ b: true });
  });

  it('omits populate entirely when there is none', () => {
    expect('populate' in toDbArgs(adaptQuery({}))).toBe(false);
  });

  it('backs v3FindArgs, which expands dotted paths', () => {
    const args = v3FindArgs({ _limit: '-1', contact: '5' }, ['project.leader']);
    expect(args.where).toEqual({ contact: 5 });
    expect(args.populate).toEqual({ project: { populate: { leader: true } } });
    expect(args.filters).toBeUndefined();
  });
});

describe('db.query call sites', () => {
  function jsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...jsFiles(full));
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  it('never hand an adaptQuery result straight to db.query', () => {
    // `.findMany(adaptQuery(...))` / `{ ...adaptQuery(...) }` — the exact shape
    // that leaked filters into the populate. Wrap it in toDbArgs instead.
    const src = path.join(__dirname, '..', 'src');
    const offenders = [];
    for (const file of jsFiles(src)) {
      const source = fs.readFileSync(file, 'utf8');
      source.split('\n').forEach((line, i) => {
        if (/\.(findMany|findOne|count|findPage)\(\s*adaptQuery\(/.test(line) ||
            /\{\s*\.\.\.adaptQuery\(/.test(line)) {
          offenders.push(`${path.relative(src, file)}:${i + 1} ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
