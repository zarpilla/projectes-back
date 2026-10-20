'use strict';

/**
 * Reports every statement sent on a MySQL connection to the change tracker
 * (issues/307).
 *
 * Installed as the pool's `afterCreate` (config/database.js), so it wraps every
 * connection knex opens, from the first one at boot: Strapi's own queries,
 * the document service, `strapi.db.connection.raw`, transactions, startup
 * scripts and crons all go through `connection.query`. knex sends BEGIN and
 * COMMIT through it too, but reports no end for them, which is why this sits
 * below knex and not on its events.
 *
 * The wrapper never changes what is sent or what comes back, and never throws
 * into a query: if the tracker fails, detection is marked broken (which turns
 * the cache off) and the statement runs as usual.
 */

const { getTracker } = require('./change-tracker');

const HOOKED = Symbol.for('esstrapis.readCache.hooked');
let nextConnectionId = 1;

function textOf(sql) {
  if (typeof sql === 'string') return sql;
  if (sql && typeof sql === 'object' && typeof sql.sql === 'string') return sql.sql;
  return undefined;
}

function valuesOf(sql, values) {
  if (Array.isArray(values)) return values;
  if (sql && typeof sql === 'object' && Array.isArray(sql.values)) return sql.values;
  return undefined;
}

/** Wraps `connection.query` and `connection.execute`. Returns the connection. */
function watchConnection(connection, tracker = getTracker()) {
  if (!connection || connection[HOOKED]) return connection;
  connection[HOOKED] = nextConnectionId++;
  const id = connection[HOOKED];

  for (const method of ['query', 'execute']) {
    const original = connection[method];
    if (typeof original !== 'function') continue;

    connection[method] = function watchedStatement(...args) {
      let statement = null;
      try {
        const values = typeof args[1] === 'function' ? undefined : args[1];
        statement = tracker.statementStarted(id, textOf(args[0]), valuesOf(args[0], values));
      } catch (error) {
        tracker.fail(error);
      }

      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        try {
          tracker.statementEnded(id, statement);
        } catch (error) {
          tracker.fail(error);
        }
      };

      // knex always passes a callback (the last argument); without one,
      // mysql2 reports the end through the returned command's events.
      const last = args.length - 1;
      if (last >= 0 && typeof args[last] === 'function') {
        const callback = args[last];
        args[last] = function watchedCallback(...results) {
          end();
          return callback.apply(this, results);
        };
        try {
          return original.apply(this, args);
        } catch (error) {
          end();
          throw error;
        }
      }
      let command;
      try {
        command = original.apply(this, args);
      } catch (error) {
        end();
        throw error;
      }
      if (command && typeof command.once === 'function') {
        command.once('end', end);
        command.once('error', end);
      } else {
        end();
      }
      return command;
    };
  }

  if (typeof connection.once === 'function') {
    const closed = () => {
      try {
        tracker.connectionClosed(id);
      } catch (error) {
        tracker.fail(error);
      }
    };
    connection.once('end', closed);
    connection.once('error', closed);
  }
  return connection;
}

/** The pool's afterCreate: watch the new connection, then hand it over. */
function afterCreate(connection, done) {
  try {
    watchConnection(connection);
  } catch (error) {
    getTracker().fail(error);
  }
  done(null, connection);
}

function isWatched(connection) {
  return Boolean(connection && connection[HOOKED]);
}

module.exports = { watchConnection, afterCreate, isWatched };
