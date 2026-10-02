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
 *   - scheduleFromPhaseRows(uid, where)  → resolve projects of phase incomes/expenses, mark dirty
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
 * Mark a single project dirty. Cheap UPDATE — no lifecycle, no read. Goes
 * through the query builder so it joins the ambient transaction (the project
 * PUT wraps phase writes and the project update); a raw knex write would wait
 * on the row lock that transaction holds.
 * @param {number|string} id project id
 */
const scheduleRefresh = async (id) => {
  const numericId = parseInt(id, 10);
  if (!(numericId > 0)) return;
  try {
    await strapi.db
      .queryBuilder('api::project.project')
      .update({ dirty: true })
      .where({ id: numericId })
      .execute();
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

const PHASE_PROJECT_POPULATE = {
  project_phase: { select: ['id'], populate: { project: { select: ['id'] } } },
  project_original_phase: { select: ['id'], populate: { project: { select: ['id'] } } },
};

/**
 * Project ids of the phase-income / phase-expense rows matching `where`, via
 * their (original) phase. v5 keeps those links in *_lnk tables, so resolve
 * them through the relations rather than a `project` column.
 * @param {string} uid api::phase-income.phase-income | api::phase-expense.phase-expense
 * @param {object} where
 * @returns {Promise<number[]>}
 */
const projectIdsForPhaseRows = async (uid, where) => {
  if (!where) return [];
  try {
    const rows = await strapi.db.query(uid).findMany({ where, select: ['id'], populate: PHASE_PROJECT_POPULATE });
    const ids = new Set();
    for (const row of rows) {
      const pid = row.project_phase?.project?.id || row.project_original_phase?.project?.id;
      if (pid) ids.add(pid);
    }
    return [...ids];
  } catch (e) {
    strapi.log.warn(`[totalsRefreshScheduler] could not resolve projects of ${uid}: ${e && e.message}`);
    return [];
  }
};

/**
 * Mark dirty the projects of the phase-income / phase-expense rows matching
 * `where`, plus any `extraIds` (e.g. the project a row belonged to before an
 * update moved it to another phase).
 */
const scheduleFromPhaseRows = async (uid, where, extraIds = []) => {
  const ids = new Set([...extraIds, ...(await projectIdsForPhaseRows(uid, where))]);
  for (const id of ids) await scheduleRefresh(id);
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
  projectIdsForPhaseRows,
  scheduleFromPhaseRows,
  flushPending,
  processDirty,
  getPendingCount,
};
