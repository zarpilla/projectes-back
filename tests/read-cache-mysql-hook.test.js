'use strict';

/**
 * issues/307 — the hook on the MySQL connections reports every statement's
 * start and end to the change tracker. What must hold:
 *   - the end is reported before the caller's callback runs, so code that
 *     continues after a COMMIT already sees the tables stamped;
 *   - every calling form of mysql2's query/execute is followed (callback,
 *     values + callback, options object, no callback: the command's events);
 *   - a statement that throws synchronously still ends;
 *   - a closed or broken connection stamps what it had pending;
 *   - the hook never breaks a query: if the tracker throws, detection is
 *     marked failed and the statement runs as usual;
 *   - a connection is wrapped once.
 * The hook against a real MySQL is covered by read-cache-mysql.test.js.
 */

const { EventEmitter } = require('events');
const { watchConnection, isWatched } = require('../src/services/read-cache/mysql-hook');

function fakeTracker() {
  return {
    calls: [],
    statementStarted(conn, sql, values) {
      this.calls.push(['start', sql, values]);
      return { sql };
    },
    statementEnded(conn, statement) {
      this.calls.push(['end', statement && statement.sql]);
    },
    connectionClosed() {
      this.calls.push(['closed']);
    },
    fail: jest.fn(),
  };
}

// mysql2-like connection: query answers on the next tick
function fakeConnection() {
  const conn = new EventEmitter();
  conn.sent = [];
  conn.query = function (sql, values, cb) {
    if (typeof values === 'function') cb = values;
    conn.sent.push(typeof sql === 'string' ? sql : sql.sql);
    const command = new EventEmitter();
    setImmediate(() => {
      if (cb) cb(null, [{ ok: 1 }], []);
      command.emit('end');
    });
    return command;
  };
  conn.execute = conn.query;
  return conn;
}

describe('watchConnection', () => {
  it('reports start and end around a statement, the end before the callback', async () => {
    const tracker = fakeTracker();
    const conn = watchConnection(fakeConnection(), tracker);
    await new Promise((resolve) =>
      conn.query({ sql: 'COMMIT;' }, [], () => {
        tracker.calls.push(['callback']);
        resolve();
      }),
    );
    expect(tracker.calls).toEqual([['start', 'COMMIT;', []], ['end', 'COMMIT;'], ['callback']]);
  });

  it('passes the answer through untouched', async () => {
    const tracker = fakeTracker();
    const conn = watchConnection(fakeConnection(), tracker);
    const answer = await new Promise((resolve) =>
      conn.query('select 1', (err, rows) => resolve({ err, rows })),
    );
    expect(answer).toEqual({ err: null, rows: [{ ok: 1 }] });
    expect(conn.sent).toEqual(['select 1']);
  });

  it('follows the (sql, callback) and (sql, values, callback) forms', async () => {
    const tracker = fakeTracker();
    const conn = watchConnection(fakeConnection(), tracker);
    await new Promise((r) => conn.query('select 1', () => r()));
    await new Promise((r) => conn.query('update t set a = ?', [1], () => r()));
    expect(tracker.calls).toEqual([
      ['start', 'select 1', undefined],
      ['end', 'select 1'],
      ['start', 'update t set a = ?', [1]],
      ['end', 'update t set a = ?'],
    ]);
  });

  it('takes the values from an options object', async () => {
    const tracker = fakeTracker();
    const conn = watchConnection(fakeConnection(), tracker);
    await new Promise((r) => conn.query({ sql: 'update ?? set a = 1', values: ['cities'] }, () => r()));
    expect(tracker.calls[0]).toEqual(['start', 'update ?? set a = 1', ['cities']]);
  });

  it('without a callback, ends on the command’s end event', async () => {
    const tracker = fakeTracker();
    const conn = watchConnection(fakeConnection(), tracker);
    const command = conn.query('delete from t');
    expect(tracker.calls).toEqual([['start', 'delete from t', undefined]]);
    await new Promise((r) => command.once('end', r));
    expect(tracker.calls).toEqual([
      ['start', 'delete from t', undefined],
      ['end', 'delete from t'],
    ]);
  });

  it('wraps execute too', async () => {
    const tracker = fakeTracker();
    const conn = watchConnection(fakeConnection(), tracker);
    await new Promise((r) => conn.execute('update t set a = ?', [1], () => r()));
    expect(tracker.calls.map((c) => c[0])).toEqual(['start', 'end']);
  });

  it('a statement that throws synchronously still ends', () => {
    const tracker = fakeTracker();
    const conn = fakeConnection();
    conn.query = () => {
      throw new Error('closed');
    };
    watchConnection(conn, tracker);
    expect(() => conn.query('update t set a = 1', () => {})).toThrow('closed');
    expect(tracker.calls.map((c) => c[0])).toEqual(['start', 'end']);
  });

  it('the end is reported once even if the driver calls back twice', async () => {
    const tracker = fakeTracker();
    const conn = fakeConnection();
    conn.query = (sql, values, cb) => {
      cb(new Error('a'));
      cb(new Error('b'));
    };
    watchConnection(conn, tracker);
    conn.query('update t set a = 1', [], () => {});
    expect(tracker.calls.filter((c) => c[0] === 'end')).toHaveLength(1);
  });

  it('a closed or broken connection is reported', () => {
    const tracker = fakeTracker();
    const a = watchConnection(fakeConnection(), tracker);
    const b = watchConnection(fakeConnection(), tracker);
    a.emit('end');
    b.emit('error', new Error('lost'));
    expect(tracker.calls.filter((c) => c[0] === 'closed')).toHaveLength(2);
  });

  it('a tracker that throws never breaks the query, and turns detection off', async () => {
    const tracker = fakeTracker();
    tracker.statementStarted = () => {
      throw new Error('boom');
    };
    tracker.statementEnded = () => {
      throw new Error('boom again');
    };
    const conn = watchConnection(fakeConnection(), tracker);
    const answer = await new Promise((resolve) => conn.query('select 1', (err, rows) => resolve(rows)));
    expect(answer).toEqual([{ ok: 1 }]);
    expect(tracker.fail).toHaveBeenCalledTimes(2);
  });

  it('wraps a connection once, and gives each one its own id', () => {
    const tracker = fakeTracker();
    const conn = fakeConnection();
    watchConnection(conn, tracker);
    const wrapped = conn.query;
    watchConnection(conn, tracker);
    expect(conn.query).toBe(wrapped);
    expect(isWatched(conn)).toBe(true);
    expect(isWatched(fakeConnection())).toBe(false);
    const other = watchConnection(fakeConnection(), tracker);
    expect(other[Symbol.for('esstrapis.readCache.hooked')]).not.toBe(
      conn[Symbol.for('esstrapis.readCache.hooked')],
    );
  });
});
