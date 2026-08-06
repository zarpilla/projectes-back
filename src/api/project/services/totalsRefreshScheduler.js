'use strict';
/* global strapi */

/**
 * In-process debouncing scheduler for refreshing a project's stored total_*
 * columns after cross-entity writes (activity, diet, ticket, invoice, grant,
 * expense, …).
 *
 * Design notes:
 *  - Lives in process memory. Acceptable because a missed refresh after a
 *    crash is healed the next time the user saves the project (the
 *    beforeUpdate hook recomputes) or via the bulk refresh endpoint.
 *  - Debounces per-project so a burst of N child writes collapses into one
 *    recompute. The mother project (if any) is scheduled after the child
 *    refresh completes, and its own debouncer collapses those bursts too.
 *  - Errors are logged, never thrown — lifecycle hooks must stay fast and
 *    non-blocking for end users.
 */

const DEBOUNCE_MS = parseInt(process.env.TOTALS_REFRESH_DEBOUNCE_MS, 10) || 2000;

// projectId -> { timeout, scheduledAt }
const pending = new Map();

const cancelPending = (id) => {
  const entry = pending.get(id);
  if (entry) {
    clearTimeout(entry.timeout);
    pending.delete(id);
  }
};

const runRefresh = async (id) => {
  pending.delete(id);
  try {
    const { refreshStoredTotals, computeStoredTotalsForProject } = require('./projectFinancials');

    await refreshStoredTotals(id);

    // Cascade to the mother. We re-read the project to find the mother id;
    // refreshStoredTotals already loaded it but doesn't return it, so do a
    // cheap targeted query.
    const motherRow = await strapi.query('project').findOne({ id }, ['mother']);
    if (motherRow && motherRow.mother) {
      const motherId = motherRow.mother.id || motherRow.mother;
      if (motherId && parseInt(motherId, 10) !== parseInt(id, 10)) {
        scheduleRefresh(motherId);
      }
    }
  } catch (e) {
    strapi.log.error(`[totalsRefreshScheduler] refresh failed for project=${id}: ${e && e.message}`);
  }
};

const scheduleRefresh = (rawId) => {
  const id = parseInt(rawId, 10);
  if (!(id > 0)) return;

  cancelPending(id);

  const timeout = setTimeout(() => runRefresh(id), DEBOUNCE_MS);
  // Don't keep the event loop alive solely for a pending refresh.
  if (timeout && typeof timeout.unref === 'function') timeout.unref();

  pending.set(id, { timeout, scheduledAt: Date.now() });
};

// Extracts every project id reachable from a lifecycle `result` (or `data`)
// object via the standard `project` (single relation) and `projects`
// (many-to-many) fields, and schedules a refresh for each. Safe to call with
// null/undefined.
const scheduleFromEntityProjects = (entity) => {
  if (!entity) return;
  if (entity.project) {
    const id = entity.project.id || entity.project;
    if (id) scheduleRefresh(id);
  }
  if (Array.isArray(entity.projects)) {
    entity.projects.forEach((p) => {
      const id = p && (p.id || p);
      if (id) scheduleRefresh(id);
    });
  }
};

// Resolves a phase-income / phase-expense row up to its owning project(s)
// and schedules refresh(es). Handles both execution and original phases.
const scheduleFromPhaseRow = async (row) => {
  if (!row) return;
  const targets = [
    { phase: row.project_phase, model: 'project-phases' },
    { phase: row.project_original_phase, model: 'project-original-phases' },
  ];
  for (const t of targets) {
    if (!t.phase) continue;
    const phaseId = t.phase.id || t.phase;
    if (!phaseId) continue;
    try {
      const phase = await strapi.query(t.model).findOne({ id: phaseId }, ['project']);
      if (phase && phase.project) {
        scheduleRefresh(phase.project.id || phase.project);
      }
    } catch (e) {
      strapi.log.warn(`[totalsRefreshScheduler] could not resolve ${t.model}#${phaseId}: ${e && e.message}`);
    }
  }
};

// Synchronously runs all pending refreshes immediately (used by tests and the
// admin endpoint when you want to drain the queue before reading totals).
const flushPending = async () => {
  const ids = [...pending.keys()];
  ids.forEach(cancelPending);
  for (const id of ids) {
    await runRefresh(id);
  }
  return ids.length;
};

const getPendingCount = () => pending.size;

module.exports = {
  scheduleRefresh,
  scheduleFromEntityProjects,
  scheduleFromPhaseRow,
  flushPending,
  getPendingCount,
  DEBOUNCE_MS,
};
