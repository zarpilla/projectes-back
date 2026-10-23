'use strict';

/**
 * issues/328 — Loki, 2026-10-23: the Tresoreria forecast of a busy tenant
 * (raiels) was rebuilt 8 times in 26 minutes. Every hours entry runs
 * `UPDATE projects SET dirty = ?` and the totals cron writes the stored totals
 * two minutes later; the read cache tracked whole tables, so both writes
 * dropped every cached piece that read a project, although the forecast never
 * reads those columns.
 *
 * Column groups: a plain UPDATE whose columns are all in a group stamps only
 * `<table>#<group>`. What must hold:
 *   - the two real statements (copied from knex's output) stamp only the group;
 *   - anything else stamps the table as before: other columns, values in the
 *     text, expressions, aliases, joins, `??`, modifiers, inserts, deletes;
 *   - by default a result that read the table depends on its groups too;
 *   - only a caller that says so (`ignoreGroups`) keeps its result across a
 *     group write; a write of other columns, or one seen by MySQL's stamps,
 *     still drops it;
 *   - group names never reach the MySQL stamps.
 */

const { ChangeTracker } = require('../src/services/read-cache/change-tracker');
const { ReadCache } = require('../src/services/read-cache/read-cache');
const { COLUMN_GROUPS, PROJECT_TOTALS, PROJECT_TOTALS_COLUMNS } = require('../src/services/read-cache/column-groups');

// knex's statements, as logged with DEBUG=knex:query on 2026-10-23
const DIRTY_SQL = 'update `projects` set `dirty` = ? where (`id` = ?)';
const TOTALS_SQL =
  'update `projects` set `total_estimated_hours` = ?, `total_estimated_hours_price` = ?, `total_estimated_incomes` = ?, ' +
  '`total_estimated_expenses` = ?, `total_estimated_expenses_vat` = ?, `estimated_incomes_expenses` = ?, ' +
  '`estimated_balance` = ?, `total_original_incomes` = ?, `total_original_expenses` = ?, `total_original_hours` = ?, ' +
  '`total_original_hours_price` = ?, `total_original_expenses_vat` = ?, `original_incomes_expenses` = ?, ' +
  '`total_real_hours` = ?, `total_real_hours_price` = ?, `total_real_incomes` = ?, `total_real_expenses` = ?, ' +
  '`total_real_expenses_vat` = ?, `total_real_incomes_expenses` = ?, `total_incomes` = ?, `total_expenses` = ?, ' +
  '`incomes_expenses` = ?, `balance` = ?, `dirty` = ? where `id` = ?';

const SCHEMA = {
  tables: ['projects', 'projects_cmps', 'tasks', 'cities'],
  foreignKeys: [{ table: 'projects_cmps', referencedTable: 'projects', deleteRule: 'CASCADE', updateRule: 'NO ACTION' }],
};

let tracker;

beforeEach(() => {
  tracker = new ChangeTracker();
  tracker.setLogger({ warn: () => {} });
  tracker.setColumnGroups(COLUMN_GROUPS);
  tracker.setSchema(SCHEMA);
});

const run = (statement, conn = 'c1', result = { affectedRows: 1 }) =>
  tracker.statementEnded(conn, tracker.statementStarted(conn, statement), null, result);

/** The tables a statement stamped. */
const stamped = (statement) => {
  const before = tracker.now();
  run(statement);
  return [...tracker.changedAt].filter(([, at]) => at > before).map(([t]) => t).sort();
};

describe('column groups in the change tracker', () => {
  it('the hours entry and the totals cron stamp only projects#totals', () => {
    expect(stamped(DIRTY_SQL)).toEqual([PROJECT_TOTALS]);
    expect(stamped(TOTALS_SQL)).toEqual([PROJECT_TOTALS]);
    expect(tracker.stats.groupWrites).toBe(2);
  });

  it('every stored total and dirty are in the group, never id or name', () => {
    for (const c of ['dirty', 'balance', 'total_real_hours', 'total_expenses_hours']) {
      expect(PROJECT_TOTALS_COLUMNS).toContain(c);
    }
    for (const c of ['id', 'name', 'trashed', 'is_mother', 'date_start', 'date_end']) {
      expect(PROJECT_TOTALS_COLUMNS).not.toContain(c);
    }
  });

  it.each([
    ['another column too', 'update `projects` set `dirty` = ?, `name` = ? where `id` = ?'],
    ['only another column', 'update `projects` set `name` = ? where `id` = ?'],
    ['a value in the text', 'update `projects` set `dirty` = 1 where `id` = 3'],
    ['an expression', 'update `projects` set `balance` = `balance` + ? where `id` = ?'],
    ['an alias', 'update `projects` as `t0` set `t0`.`dirty` = ? where `t0`.`id` = ?'],
    ['a join', 'update `projects` join `tasks` on `tasks`.`id` = ? set `dirty` = ?'],
    ['two tables', 'update `projects`, `tasks` set `dirty` = ?'],
    ['identifiers as values', 'update ?? set ?? = ? where `id` = ?'],
    ['a modifier', 'update low_priority `projects` set `dirty` = ?'],
    ['bare names', 'update projects set dirty = ? where id = ?'],
    ['a comment', 'update `projects` set /* x */ `dirty` = ? where `id` = ?'],
    ['an order and limit without where', 'update `projects` set `dirty` = ? limit 1'],
  ])('%s: the whole table changes', (_label, statement) => {
    const before = tracker.now();
    run(statement);
    // stamped, or everything changed (`??` names no table)
    expect(tracker.changedSince(['projects'], before)).toBe(true);
    expect(tracker.stats.groupWrites).toBe(0);
  });

  it('a group column of a table without groups is a plain write', () => {
    expect(stamped('update `tasks` set `dirty` = ? where `id` = ?')).toEqual(['tasks']);
  });

  it('inserts and deletes stamp the table and its cascades', () => {
    expect(stamped('insert into `projects` (`dirty`) values (?)')).toEqual(['projects', 'projects_cmps']);
    expect(stamped('delete from `projects` where `id` = ?')).toEqual(['projects', 'projects_cmps']);
  });

  it('an update without where may still be a group write', () => {
    expect(stamped('update `projects` set `dirty` = ?')).toEqual([PROJECT_TOTALS]);
  });

  it('inside a transaction the group is stamped again at COMMIT', () => {
    run('BEGIN', 'tx');
    run(DIRTY_SQL, 'tx');
    const before = tracker.now();
    run('COMMIT', 'tx');
    expect(tracker.changedSince([PROJECT_TOTALS], before)).toBe(true);
    expect(tracker.changedSince(['projects'], before)).toBe(false);
  });

  it('a group can not hold id', () => {
    expect(() => tracker.setColumnGroups({ projects: { bad: ['dirty', 'id'] } })).toThrow(/id/);
  });

  it('withGroups adds the groups of the tables, except the ignored ones', () => {
    expect(tracker.withGroups(['projects', 'cities']).sort()).toEqual(['cities', 'projects', PROJECT_TOTALS]);
    expect(tracker.withGroups(['projects'], [PROJECT_TOTALS])).toEqual(['projects']);
    expect(tracker.isTable(PROJECT_TOTALS)).toBe(true);
  });
});

describe('column groups in the read cache', () => {
  let cache;
  let stamps;

  beforeEach(() => {
    stamps = {
      watched: [],
      covered: [],
      watch(tables) {
        this.watched.push(...tables);
      },
      completed: () => 0,
      completedAt: () => 0,
      coveredSince(tables) {
        this.covered.push(...tables);
        return true;
      },
      fresh: async () => {},
    };
    cache = new ReadCache({ tracker, stamps, log: { warn: jest.fn(), error: jest.fn() } });
    cache.enable();
  });

  // a load that reads the projects table, as the hook would report it
  const projectsLoader = (value) =>
    jest.fn(async () => {
      tracker.statementEnded('c1', tracker.statementStarted('c1', 'select `id`, `name` from `projects`'));
      return value;
    });
  const elsewhere = (statement) => tracker.capture.exit(() => run(statement, 'c2'));

  it('by default a result that read projects is dropped by a totals write', async () => {
    const loader = projectsLoader({ n: 1 });
    await cache.get('k', loader);
    elsewhere(DIRTY_SQL);
    await cache.get('k', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('with ignoreGroups it survives totals writes, not other writes', async () => {
    const loader = projectsLoader({ n: 1 });
    const opts = { ignoreGroups: [PROJECT_TOTALS] };
    await cache.get('k', loader, opts);
    elsewhere(DIRTY_SQL);
    elsewhere(TOTALS_SQL);
    await cache.get('k', loader, opts);
    expect(loader).toHaveBeenCalledTimes(1);

    elsewhere('update `projects` set `name` = ? where `id` = ?');
    await cache.get('k', loader, opts);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('with ignoreGroups a change seen by the MySQL stamps still drops it', async () => {
    const loader = projectsLoader({ n: 1 });
    const opts = { ignoreGroups: [PROJECT_TOTALS] };
    await cache.get('k', loader, opts);
    tracker.externalChange(['projects']);
    await cache.get('k', loader, opts);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('a result kept inside another one that does not ignore the group carries it', async () => {
    const inner = projectsLoader({ n: 1 });
    const outer = jest.fn(async () => ({ inner: await cache.get('inner', inner) }));
    await cache.get('outer', outer, { ignoreGroups: [PROJECT_TOTALS] });
    elsewhere(DIRTY_SQL);
    await cache.get('outer', outer, { ignoreGroups: [PROJECT_TOTALS] });
    expect(outer).toHaveBeenCalledTimes(2);
  });

  it('group names never reach the MySQL stamps', async () => {
    const loader = projectsLoader({ n: 1 });
    await cache.get('k', loader);
    await cache.get('k', loader);
    expect(stamps.watched).toContain('projects');
    expect(stamps.watched).not.toContain(PROJECT_TOTALS);
    expect(stamps.covered).toContain('projects');
    expect(stamps.covered).not.toContain(PROJECT_TOTALS);
  });
});
