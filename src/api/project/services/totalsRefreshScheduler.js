'use strict';
/* global strapi */

/**
 * totalsRefreshScheduler (v5) — PM2-safe redesign (P4.10).
 *
 * The v3 scheduler used an in-process setTimeout+Map debounce, which is broken
 * under the production 16-instance PM2 cluster (each instance has its own map;
 * refreshes duplicated or lost). This redesign uses the `projects.dirty` flag
 * as the coordination point:
 *
 *   - scheduleRefresh(id)                → mark the project dirty (cheap UPDATE,
 *                                          knex, no lifecycle)
 *   - scheduleFromEntityProjects(entity) → mark all linked projects dirty
 *   - scheduleFromPhaseRow(phaseRow)     → resolve project from a phase row, mark dirty
 *   - flushPending() / processDirty()    → refresh ALL dirty projects (used by the
 *                                          cron worker and the admin drain endpoint)
 *
 * Any PM2 instance can mark dirty; a single cron task (config/cron.js, every 2
 * minutes) drains the queue. Multiple instances draining concurrently is safe:
 * refreshStoredTotals recomputes from source data and the final update is
 * idempotent (same totals, dirty=false).
 *
 * NOTE: the projects table must have a `dirty` column (it does — ported from v3).
 */

const { refreshStoredTotals } = require('./projectFinancials');

/**
 * Mark a single project dirty. Cheap knex UPDATE — no lifecycle, no read.
 * @param {number|string} id project id
 */
const scheduleRefresh = async (id) => {
  const numericId = parseInt(id, 10);
  if (!(numericId > 0)) return;
  try {
    await strapi.db.connection('projects').where({ id: numericId }).update({ dirty: true });
  } catch (e) {
    strapi.log.warn(`[totalsRefreshScheduler] scheduleRefresh(${id}): ${e && e.message}`);
  }
};

/**
 * Mark every project linked to an entity dirty. The entity may carry a single
 * `.project` (id or object), a `.projects` array (manyToMany), or both.
 * @param {object} entity a v5 row (relation may be id or populated object)
 */
const scheduleFromEntityProjects = async (entity) => {
  if (!entity) return;
  const ids = new Set();

  const pushId = (v) => {
    if (v == null) return;
    if (typeof v === 'object' && v.id != null) ids.add(v.id);
    else if (typeof v !== 'object') ids.add(parseInt(v, 10));
  };

  pushId(entity.project);
  if (Array.isArray(entity.projects)) entity.projects.forEach(pushId);

  for (const id of ids) {
    if (id > 0) await scheduleRefresh(id);
  }
};

/**
 * Resolve the project of a phase row (project_phases or project_original_phases)
 * and mark it dirty. The phase row may carry a populated project, a bare
 * project id, or nothing (in which case we look the phase up).
 * @param {object} phaseRow
 */
const scheduleFromPhaseRow = async (phaseRow) => {
  if (!phaseRow) return;

  // Direct project reference on the row
  if (phaseRow.project != null) {
    if (typeof phaseRow.project === 'object' && phaseRow.project.id != null) {
      return scheduleRefresh(phaseRow.project.id);
    }
    const pid = parseInt(phaseRow.project, 10);
    if (pid > 0) return scheduleRefresh(pid);
  }

  // Otherwise resolve via the phase id + table
  const phaseId = parseInt(phaseRow.id, 10);
  const isOriginal =
    phaseRow.model === 'project-original-phases' ||
    phaseRow.project_original_phase !== undefined ||
    phaseRow.__original === true;
  const table = isOriginal ? 'project_original_phases' : 'project_phases';
  if (!(phaseId > 0)) return;

  try {
    const rows = await strapi.db.connection(table).where({ id: phaseId }).select('project');
    if (rows.length && rows[0].project) {
      await scheduleRefresh(rows[0].project);
    }
  } catch (e) {
    strapi.log.warn(`[totalsRefreshScheduler] could not resolve ${table}#${phaseId}: ${e && e.message}`);
  }
};

/**
 * Refresh every dirty project (drain the queue). Returns the count processed.
 * Used by the cron worker and by flushPending.
 */
const processDirty = async () => {
  let dirtyIds;
  try {
    const rows = await strapi.db.connection('projects').where({ dirty: true }).select('id');
    dirtyIds = rows.map((r) => r.id);
  } catch (e) {
    strapi.log.warn(`[totalsRefreshScheduler] processDirty read: ${e && e.message}`);
    return 0;
  }

  let ok = 0;
  let failed = 0;
  for (const id of dirtyIds) {
    try {
      await refreshStoredTotals(id);
      ok++;
    } catch (e) {
      failed++;
      strapi.log.error(`[totalsRefreshScheduler] refresh project=${id}: ${e && e.message}`);
      // Leave dirty=true on failure so the next cron pass retries it.
    }
  }
  if (dirtyIds.length) {
    strapi.log.info(
      `[totalsRefreshScheduler] processed ${ok}/${dirtyIds.length} dirty projects` +
        (failed ? ` (${failed} failed, will retry)` : ''),
    );
  }
  return ok;
};

// Backwards-compatible alias (v3 exposed flushPending; drains the queue now).
const flushPending = processDirty;

// Kept for API parity with v3; with the DB-backed design there is no in-process
// pending set — the count of dirty projects is the queue length.
const getPendingCount = async () => {
  try {
    const rows = await strapi.db.connection('projects').where({ dirty: true }).count('id as n');
    return rows[0]?.n || 0;
  } catch {
    return 0;
  }
};

module.exports = {
  scheduleRefresh,
  scheduleFromEntityProjects,
  scheduleFromPhaseRow,
  flushPending,
  processDirty,
  getPendingCount,
};
