'use strict';

/**
 * Tasks, phase 2: the next occurrence of a recurring task, and who is told at once
 * when a task is assigned or a comment mentions them.
 */
const { nextDates, nextTaskData, shiftDate } = require('../src/api/task/services/recurrence');
const { newlyAssigned, assignmentEmail, mentionEmail } = require('../src/api/task/services/notify');

describe('recurring tasks', () => {
  it('moves the due date one period (month ends stay valid)', () => {
    expect(shiftDate('2026-10-17', 'weekly')).toBe('2026-10-24');
    expect(shiftDate('2026-10-17', 'biweekly')).toBe('2026-10-31');
    expect(shiftDate('2026-01-31', 'monthly')).toBe('2026-02-28');
    expect(shiftDate('2026-10-17', 'quarterly')).toBe('2027-01-17');
    expect(shiftDate('2026-10-17', 'yearly')).toBe('2027-10-17');
  });

  it('keeps the span between start and due date; without due date counts from today', () => {
    expect(nextDates({ recurrence: 'monthly', start_date: '2026-10-01', due_date: '2026-10-10' }))
      .toEqual({ due_date: '2026-11-10', start_date: '2026-11-01' });
    expect(nextDates({ recurrence: 'weekly' }, '2026-10-17')).toEqual({ due_date: '2026-10-24', start_date: null });
  });

  it('copies the task to the first state with the checklist unticked', () => {
    const data = nextTaskData({
      name: 'Revisar les hores', recurrence: 'monthly', due_date: '2026-10-31', priority: 'high',
      project: { id: 4 }, activity_type: { id: 7 }, users_permissions_users: [{ id: 8 }, { id: 9 }],
      estimated_hours: 2, created: { id: 8 },
      checklist: [{ name: 'Hores', done: true, user: { id: 9 }, due_date: '2026-10-30' }],
    }, 1, '2026-10-31');
    expect(data).toMatchObject({
      name: 'Revisar les hores', project: 4, activity_type: 7, users_permissions_users: [8, 9], priority: 'high',
      estimated_hours: 2, recurrence: 'monthly', task_state: 1, archived: false, due_date: '2026-11-30',
      checklist: [{ name: 'Hores', done: false, user: 9, due_date: '2026-11-30' }],
    });
  });
});

describe('task notices at once', () => {
  it('only the people added by this save, not the one who saved', () => {
    const a = { id: 1, email: 'a@x.cat' };
    const b = { id: 2, email: 'b@x.cat' };
    const c = { id: 3, email: 'c@x.cat' };
    expect(newlyAssigned([a], [a, b, c], 3)).toEqual([b]);
    expect(newlyAssigned(null, [a], null)).toEqual([a]);
    expect(newlyAssigned([a, b], [a], 1)).toEqual([]);
  });

  it('emails link the task and escape what people wrote', () => {
    const task = { id: 12, name: 'Fer <l\'acta>', due_date: '2026-10-20', project: { name: 'Bellmodel' } };
    const assigned = assignmentEmail(task, { username: 'Laia' }, 'https://x.cat/')
    expect(assigned.subject).toBe("[ESSTRAPIS] T'han assignat una tasca: Fer <l'acta>");
    expect(assigned.html).toContain('Fer &lt;l\'acta&gt;');
    expect(assigned.html).toContain('20/10/2026');
    expect(assigned.html).toContain('https://x.cat/tasks?task=12');
    const mention = mentionEmail(task, { text: 'Hola @Pau\n<b>ja</b>' }, { username: 'Laia' }, 'https://x.cat/');
    expect(mention.html).toContain('Hola @Pau<br>&lt;b&gt;ja&lt;/b&gt;');
  });
});
