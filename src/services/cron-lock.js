'use strict';

/**
 * Runs a cron task in only one instance of a tenant at a time.
 *
 * Zero-downtime deploys start the new backend next to the old one and switch
 * over once it is healthy, so for a few seconds two instances of the same
 * tenant run the same cron schedule. Jobs like the FACe retry must not run twice
 * at once (double submission), so each task takes a MySQL named lock and skips
 * the run when another instance holds it.
 *
 * GET_LOCK is server-wide and every tenant shares the MySQL server, so the lock
 * name carries the database name. The lock belongs to the connection that took
 * it; a transaction pins that connection until the task ends (or MySQL drops it
 * if the process dies). Other databases (sqlite in development) run the task
 * directly.
 */
const crypto = require('crypto');

function lockName(database, task) {
  const name = `cron:${database}:${task}`;
  // MySQL limits lock names to 64 characters.
  return name.length <= 64 ? name : `cron:${crypto.createHash('sha1').update(name).digest('hex')}`;
}

async function withCronLock(task, fn, strapiInstance = global.strapi) {
  const db = strapiInstance.config.get('database.connection') || {};
  if (!['mysql', 'mysql2'].includes(db.client)) return fn();

  const key = lockName((db.connection && db.connection.database) || '', task);
  return strapiInstance.db.connection.transaction(async (trx) => {
    const [rows] = await trx.raw('SELECT GET_LOCK(?, 0) AS got', [key]);
    if (!rows || !rows[0] || Number(rows[0].got) !== 1) {
      strapiInstance.log.info(`[cron] ${task} skipped: already running in another instance`);
      return undefined;
    }
    try {
      return await fn();
    } finally {
      await trx.raw('SELECT RELEASE_LOCK(?)', [key]);
    }
  });
}

module.exports = { withCronLock, lockName };
