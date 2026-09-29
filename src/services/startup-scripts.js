'use strict';
/* global strapi */

/**
 * One-time data fixes run from bootstrap — the v3 `runStartupScript` guard,
 * ported. Each run is recorded in `startup_scripts` (name, start, end):
 *
 *   - a finished run (end set) is never repeated;
 *   - a run that started but never finished (crash, killed instance) is NOT
 *     retried automatically either — it needs a look, not a second pass.
 *
 * With runOnce: false the script runs on every boot and is still recorded.
 *
 * The row is claimed BEFORE the handler runs, so with several PM2 instances
 * booting together only the first one past the check does the work; a
 * concurrent booter at worst also runs it, which is why handlers are idempotent.
 */
const UID = 'api::startup-script.startup-script';

async function runStartupScript(scriptName, scriptHandler, options = {}) {
  const runOnce = options.runOnce !== false;
  const query = strapi.db.query(UID);

  const lastRun = await query.findOne({ where: { name: scriptName }, orderBy: { id: 'desc' } });

  if (runOnce && lastRun && lastRun.end) {
    strapi.log.info(`[STARTUP SCRIPT] Skipping ${scriptName} (already completed on ${lastRun.end})`);
    return;
  }
  if (runOnce && lastRun && lastRun.start && !lastRun.end) {
    strapi.log.warn(`[STARTUP SCRIPT] Skipping ${scriptName} (found previous run without end: ${lastRun.start})`);
    return;
  }

  const execution = await query.create({ data: { name: scriptName, start: new Date() } });
  strapi.log.info(`[STARTUP SCRIPT] Running ${scriptName} (execution #${execution.id})`);

  try {
    await scriptHandler();
    await query.update({ where: { id: execution.id }, data: { end: new Date() } });
    strapi.log.info(`[STARTUP SCRIPT] Completed ${scriptName} (execution #${execution.id})`);
  } catch (error) {
    strapi.log.error(`[STARTUP SCRIPT] Failed ${scriptName} (execution #${execution.id}): ${error && error.stack}`);
    throw error;
  }
}

module.exports = { runStartupScript };
