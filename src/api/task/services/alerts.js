'use strict';

/**
 * The Tasques menu dot (issues/307): the logged-in person's overdue tasks and
 * checklist items, and what is new for her since she last opened Tasques
 * (tasks others gave her, mentions in comments).
 *
 * The same rules the front applied (projectes-front src/domain/tasks.js
 * taskAlerts, now moved here) to three lists it asked on every page load: her
 * tasks with everything populated (~40 KB), the task states and the
 * mentions. Computed here on the few fields they need.
 */
const { doneStateId } = require('./done-state');

const idOf = (value) => (value && typeof value === 'object' ? value.id : value);

function isDone(task, states) {
  const done = doneStateId(states);
  return done !== null && idOf(task.task_state) === done;
}

/** Due before today and not done. */
const isOverdue = (task, states, today) => !!task.due_date && task.due_date < today && !isDone(task, states);

// the dates as the API answers them, to compare with the front's ISO `seen`
const iso = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * @param {{ tasks: object[], states: object[], mentions: object[], me: number, seenAt: string|null, today: string }} input
 * @returns {{ overdue: number, fresh: number }}
 */
function taskAlerts({ tasks = [], states = [], mentions = [], me, seenAt = null, today }) {
  const mine = (t) => (t.users_permissions_users || []).some((u) => idOf(u) === me);
  const overdueTasks = tasks.filter((t) => !t.archived && mine(t) && isOverdue(t, states, today)).length;
  const overdueChecks = tasks
    .filter((t) => !t.archived && !isDone(t, states))
    .reduce(
      (n, t) =>
        n + (t.checklist || []).filter((c) => idOf(c.user) === me && !c.done && c.due_date && c.due_date < today).length,
      0,
    );
  const after = (at) => !seenAt || (iso(at) && iso(at) > seenAt);
  const freshTasks = tasks.filter(
    (t) => !t.archived && mine(t) && !isDone(t, states) && idOf(t.created) !== me && after(t.createdAt),
  ).length;
  const freshMentions = mentions.filter((c) => after(c.createdAt) && (!c.author || idOf(c.author) !== me)).length;
  return { overdue: overdueTasks + overdueChecks, fresh: freshTasks + freshMentions };
}

module.exports = { taskAlerts, iso };
