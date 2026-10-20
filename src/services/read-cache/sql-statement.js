'use strict';

/**
 * What a SQL statement can do to the data, read from its text (issues/307).
 *
 * The read cache drops what it keeps when a table it depends on is written, and
 * it learns about writes from the statements this process sends to MySQL. This
 * module only sorts statements; which tables a statement touches is decided by
 * the change tracker, which knows the database's table names.
 *
 * The rule is fail-safe: a statement is a harmless read only when it clearly is
 * one. Anything not recognised is `unknown`, which the tracker treats as a
 * change of every table. Getting a write wrong would serve stale data; getting
 * a read wrong only costs a reload.
 *
 * Kinds:
 *   read     SELECT / SHOW / DESCRIBE / EXPLAIN / WITH / TABLE / VALUES with no
 *            write keyword anywhere in the text: changes nothing.
 *   write    INSERT / UPDATE / DELETE / REPLACE / LOAD / IMPORT: changes the
 *            tables named in it (and the tables its foreign keys cascade to).
 *   schema   CREATE / ALTER / DROP / RENAME / TRUNCATE / OPTIMIZE: changes
 *            tables and maybe their shape; commits an open transaction.
 *   tx       BEGIN / START / COMMIT / ROLLBACK / SAVEPOINT / RELEASE / XA /
 *            SET TRANSACTION. `endsTransaction` is true for a full COMMIT or
 *            ROLLBACK (not ROLLBACK TO SAVEPOINT).
 *   session  SET (session variables), USE, KILL: no data change.
 *   unknown  anything else, several statements in one string, an empty or
 *            non-string statement, a MySQL executable comment.
 */

const READ_FIRST = new Set(['select', 'show', 'describe', 'desc', 'explain', 'with', 'table', 'values']);
const WRITE_FIRST = new Set(['insert', 'update', 'delete', 'replace', 'load', 'import']);
const SCHEMA_FIRST = new Set(['create', 'alter', 'drop', 'rename', 'truncate', 'optimize']);
const TX_FIRST = new Set(['begin', 'start', 'commit', 'rollback', 'savepoint', 'release', 'xa']);
const SESSION_FIRST = new Set(['set', 'use', 'kill']);

// Words that make a statement more than a read wherever they appear. A column
// or a string with one of these words only makes a read count as a write.
const WRITE_WORD =
  /\b(insert|update|delete|replace|truncate|drop|alter|create|rename|load|import|call|handler|grant|revoke|lock|unlock|execute|prepare|optimize)\b/i;

// MySQL: `#`, or `--` followed by a blank or the end (`5--2` is arithmetic)
const isLineComment = (text, i) =>
  text[i] === '#' ||
  (text[i] === '-' && text[i + 1] === '-' && (i + 2 >= text.length || /\s/.test(text[i + 2])));

/**
 * The text after leading blanks, comments and opening parentheses. Returns
 * null for a MySQL executable comment (`/*! ... *\/`), whose content runs.
 */
function stripLeading(sql) {
  let i = 0;
  const n = sql.length;
  for (;;) {
    while (i < n && /\s/.test(sql[i])) i++;
    if (sql.startsWith('/*!', i)) return null;
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return '';
      i = end + 2;
      continue;
    }
    if (isLineComment(sql, i)) {
      const end = sql.indexOf('\n', i);
      if (end === -1) return '';
      i = end + 1;
      continue;
    }
    if (sql[i] === '(') {
      i++;
      continue;
    }
    return sql.slice(i);
  }
}

/**
 * True when a `;` outside quotes and comments is followed by more text: more
 * than one statement. An unterminated quote or comment also answers true, so
 * text we can't read is never taken for a single harmless statement.
 */
function hasSeveralStatements(sql) {
  const text = sql.replace(/[\s;]+$/, '');
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      i++;
      for (;;) {
        if (i >= n) return true;
        if (text[i] === '\\' && c !== '`') {
          i += 2;
          continue;
        }
        if (text[i] === c) {
          if (text[i + 1] === c) {
            i += 2; // doubled quote inside the literal
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return true;
      i = end + 2;
      continue;
    }
    if (isLineComment(text, i)) {
      const end = text.indexOf('\n', i);
      if (end === -1) return false;
      i = end + 1;
      continue;
    }
    if (c === ';') return true;
    i++;
  }
  return false;
}

/**
 * Sorts one statement.
 * @param {string} sql
 * @returns {{ kind: 'read'|'write'|'schema'|'tx'|'session'|'unknown', endsTransaction?: boolean }}
 */
function classify(sql) {
  if (typeof sql !== 'string') return { kind: 'unknown' };
  const text = stripLeading(sql);
  if (text === null || text === '') return { kind: 'unknown' };
  if (hasSeveralStatements(text)) return { kind: 'unknown' };

  const match = /^[a-z]+/i.exec(text);
  if (!match) return { kind: 'unknown' };
  const first = match[0].toLowerCase();

  if (READ_FIRST.has(first)) {
    return WRITE_WORD.test(text) ? { kind: 'write' } : { kind: 'read' };
  }
  if (WRITE_FIRST.has(first)) return { kind: 'write' };
  if (SCHEMA_FIRST.has(first)) return { kind: 'schema' };
  if (TX_FIRST.has(first)) {
    const words = text
      .toLowerCase()
      .replace(/[\s;]+$/, '')
      .split(/\s+/);
    if (first === 'commit') return { kind: 'tx', endsTransaction: true };
    if (first === 'rollback') return { kind: 'tx', endsTransaction: words[1] !== 'to' };
    return { kind: 'tx', endsTransaction: false };
  }
  if (SESSION_FIRST.has(first)) {
    // SET TRANSACTION ISOLATION LEVEL ... comes before a BEGIN
    if (first === 'set' && /^set\s+(session\s+|global\s+|local\s+)?transaction\b/i.test(text)) {
      return { kind: 'tx', endsTransaction: false };
    }
    return { kind: 'session' };
  }
  return { kind: 'unknown' };
}

module.exports = { classify, stripLeading, hasSeveralStatements };
