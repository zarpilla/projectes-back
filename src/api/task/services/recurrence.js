'use strict';

/**
 * Recurring tasks: when a task with a recurrence reaches the done state, a copy is
 * created for the next period (same people, project, Funció, priority, estimate and
 * checklist unticked), with its dates moved by one period. Without a due date the
 * next one counts from the day it was finished.
 */
const moment = require('moment');

const PERIODS = {
  weekly: [1, 'week'],
  biweekly: [2, 'weeks'],
  monthly: [1, 'month'],
  quarterly: [3, 'months'],
  yearly: [1, 'year'],
};

function shiftDate(date, recurrence) {
  const period = PERIODS[recurrence];
  if (!period || !date) return null;
  return moment(date, 'YYYY-MM-DD').add(period[0], period[1]).format('YYYY-MM-DD');
}

/** Dates of the next occurrence: { due_date, start_date }. */
function nextDates(task, today = moment().format('YYYY-MM-DD')) {
  const due = shiftDate(task.due_date || today, task.recurrence);
  let start = null;
  if (task.start_date) {
    const span = task.due_date ? moment(task.due_date).diff(moment(task.start_date), 'days') : 0;
    start = moment(due, 'YYYY-MM-DD').subtract(span, 'days').format('YYYY-MM-DD');
  }
  return { due_date: due, start_date: start };
}

/** Data of the next task, from the finished one (populated relations). */
function nextTaskData(task, firstStateId, today) {
  const ids = (list) => (list || []).map((x) => x.id);
  return {
    name: task.name,
    description: task.description,
    project: task.project ? task.project.id : null,
    activity_type: task.activity_type ? task.activity_type.id : null,
    users_permissions_users: ids(task.users_permissions_users),
    priority: task.priority || 'normal',
    estimated_hours: task.estimated_hours,
    recurrence: task.recurrence,
    task_state: firstStateId,
    archived: false,
    created: task.created ? task.created.id : null,
    checklist: (task.checklist || []).map((c) => ({
      name: c.name,
      done: false,
      user: c.user ? c.user.id : null,
      due_date: c.due_date ? shiftDate(c.due_date, task.recurrence) : null,
    })),
    ...nextDates(task, today),
  };
}

module.exports = { PERIODS, shiftDate, nextDates, nextTaskData };
