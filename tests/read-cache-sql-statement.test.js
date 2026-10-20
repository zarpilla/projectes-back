'use strict';

/**
 * issues/307 — the read cache learns about writes from the statements this
 * process sends to MySQL. A write taken for a read would leave stale data in
 * the cache, so the classifier must never call a statement a read unless it
 * clearly is one; anything it can't read is `unknown` (a change of every
 * table). These cases cover what knex/Strapi send, the raw SQL of this code
 * base and the forms MySQL accepts that could hide a write.
 */

const { classify, hasSeveralStatements } = require('../src/services/read-cache/sql-statement');

const kind = (sql) => classify(sql).kind;

describe('classify: reads', () => {
  it.each([
    'select * from `project_types`',
    'select `t0`.`id`, `t0`.`name` from `project_types` as `t0` where (`t0`.`published_at` is not null) order by `t0`.`name` asc limit ?',
    'select count(*) as `count` from (select distinct `t0`.`id` from `cities` as `t0`) as `count`',
    'SELECT GET_LOCK(?, 0) AS got',
    'SELECT RELEASE_LOCK(?)',
    '  \n select 1',
    '(select id from a) union (select id from b)',
    '/* a comment */ select 1',
    '-- comment\nselect 1',
    '# comment\nselect 1',
    'SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM t',
    'show tables',
    'SHOW INDEX FROM `orders_emitted_invoice_lnk`',
    'describe `projects`',
    'explain select * from projects',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'TABLE project_types',
    'VALUES ROW(1, 2)',
    "select * from t where note = 'a;b'",
    'select * from t where `a;b` = 1',
    'select * from t;',
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
    "select * from contacts where city = 'it''s'",
    'select 5--2',
  ])('%s', (sql) => {
    expect(kind(sql)).toBe('read');
  });
});

describe('classify: writes', () => {
  it.each([
    'insert into `project_types` (`name`) values (?)',
    'update `project_types` set `name` = ? where `id` in (?)',
    'delete from `project_types` where `id` in (?)',
    'replace into t values (1)',
    'INSERT IGNORE INTO t VALUES (1)',
    'insert into t (a) values (1) on duplicate key update a = values(a)',
    'UPDATE emitted_invoices SET vat_paid_date = ? WHERE id = ?',
    'update `projects` set `dirty` = ? where `id` in (select project_id from x)',
    'delete `t0` from `projects` as `t0` inner join x on x.id = t0.id',
    'LOAD DATA INFILE "x.csv" INTO TABLE t',
    '/* why */ UPDATE t SET a = 1',
    '-- why\nDELETE FROM t',
    '(UPDATE t SET a = 1)',
    // a read keyword in front of a write
    'WITH x AS (SELECT id FROM a) DELETE FROM b WHERE id IN (SELECT id FROM x)',
    'WITH x AS (SELECT 1) UPDATE t SET a = 1',
    'EXPLAIN ANALYZE DELETE FROM t',
    'select * from t for update',
    'select * from t where note = ? lock in share mode',
    // a write word anywhere makes a read count as a write (only a reload lost)
    "select * from t where note = 'please update'",
  ])('%s', (sql) => {
    expect(kind(sql)).toBe('write');
  });
});

describe('classify: schema, transactions, session', () => {
  it.each([
    ['create table `x` (`id` int)', 'schema'],
    [
      'CREATE UNIQUE INDEX orders_emitted_invoice_order_uq ON orders_emitted_invoice_lnk (order_id)',
      'schema',
    ],
    ['alter table `x` add `y` int', 'schema'],
    ['drop table if exists `x`', 'schema'],
    ['RENAME TABLE a TO b', 'schema'],
    ['truncate `x`', 'schema'],
    ['TRUNCATE TABLE x', 'schema'],
    ['OPTIMIZE TABLE x', 'schema'],
    ['SET NAMES utf8mb4', 'session'],
    ['SET SESSION information_schema_stats_expiry = 0', 'session'],
    ['set autocommit = 0', 'session'],
    ['SET FOREIGN_KEY_CHECKS = 0', 'session'],
    ['USE other_db', 'session'],
    ['KILL QUERY ?', 'session'],
  ])('%s → %s', (sql, expected) => {
    expect(kind(sql)).toBe(expected);
  });

  it.each([
    ['BEGIN;', false],
    ['begin', false],
    ['START TRANSACTION', false],
    ['START TRANSACTION READ ONLY', false],
    ['SET TRANSACTION ISOLATION LEVEL READ COMMITTED;', false],
    ['SET SESSION TRANSACTION READ ONLY', false],
    ['SAVEPOINT trx3;', false],
    ['RELEASE SAVEPOINT trx3;', false],
    ['ROLLBACK TO SAVEPOINT trx3', false],
    ['rollback to trx3', false],
    ['XA START "x"', false],
    ['COMMIT;', true],
    ['commit', true],
    ['COMMIT WORK', true],
    ['ROLLBACK', true],
    ['ROLLBACK;', true],
    ['rollback work', true],
  ])('%s is a transaction statement (ends it: %s)', (sql, ends) => {
    expect(classify(sql)).toEqual({ kind: 'tx', endsTransaction: ends });
  });
});

describe('classify: unknown counts as a change of everything', () => {
  it.each([
    ['CALL refresh_totals()', 'a procedure'],
    ['DO SLEEP(1)', 'DO'],
    ['LOCK TABLES t WRITE', 'table locks'],
    ['UNLOCK TABLES', 'table locks'],
    ['HANDLER t OPEN', 'handler'],
    ['PREPARE s FROM "DELETE FROM t"', 'prepared statement'],
    ['EXECUTE s', 'prepared statement'],
    ['GRANT ALL ON *.* TO x', 'privileges'],
    ['FLUSH TABLES', 'flush'],
    ['ANALYZE TABLE t', 'analyze'],
    ['/*!40101 SET NAMES utf8 */', 'executable comment'],
    ['/*!50000 DELETE FROM t */', 'executable comment'],
    ['select 1; delete from t', 'two statements'],
    ['update t set a = 1; select 1', 'two statements'],
    ["select 'unterminated", 'unterminated quote'],
    ['select 1 /* unterminated', 'unterminated comment'],
    ['', 'empty'],
    ['   ', 'blank'],
    ['/* only a comment */', 'only a comment'],
    ['42', 'no keyword'],
  ])('%s (%s)', (sql) => {
    expect(kind(sql)).toBe('unknown');
  });

  it('a statement that is not a string is unknown', () => {
    expect(kind(undefined)).toBe('unknown');
    expect(kind(null)).toBe('unknown');
    expect(kind({})).toBe('unknown');
    expect(kind(42)).toBe('unknown');
  });
});

describe('hasSeveralStatements', () => {
  it.each([
    ['select 1', false],
    ['select 1;', false],
    ['select 1;  \n ', false],
    ['select 1;;', false],
    ["select ';'", false],
    ['select ";"', false],
    ['select `;`', false],
    ["select 'a\\';b'", false],
    ["select 'a'';b'", false],
    ['select 1 /* ; */', false],
    ['select 1 -- ;\n', false],
    ['select 1 # ;\n', false],
    ['select 1; select 2', true],
    ["select 'x'; delete from t", true],
    ['select 5--2; delete from t', true],
    ["select 'open", true],
  ])('%s → %s', (sql, expected) => {
    expect(hasSeveralStatements(sql)).toBe(expected);
  });
});
