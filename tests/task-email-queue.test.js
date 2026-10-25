'use strict';

/**
 * Queued task emails (services/notify.js): an assignment undone in the meantime or a
 * deleted comment sends nothing, repeated notices go once, and several notices for the
 * same person go out as one email.
 */
const { stillValid, groupNotices, noticesEmail, removedFrom } = require('../src/api/task/services/notify');

const anna = { id: 8, username: 'Anna', email: 'anna@x.cat' };
const pau = { id: 9, username: 'Pau', email: 'pau@x.cat' };
const laia = { id: 5, username: 'Laia' };
const task = (id, people, extra = {}) => ({ id, name: `Tasca ${id}`, users_permissions_users: people, project: { name: 'Bellmodel' }, ...extra });

describe('task email queue', () => {
  it('drops an assignment when the person is no longer on the task, or the task is archived', () => {
    expect(stillValid({ kind: 'assigned', recipient: anna, task: task(1, [anna]) })).toBe(true);
    expect(stillValid({ kind: 'assigned', recipient: anna, task: task(1, [pau]) })).toBe(false);
    expect(stillValid({ kind: 'assigned', recipient: anna, task: task(1, [anna], { archived: true }) })).toBe(false);
    expect(stillValid({ kind: 'assigned', recipient: anna, task: null })).toBe(false);
  });

  it('drops a mention whose comment was deleted', () => {
    expect(stillValid({ kind: 'mention', recipient: anna, task: task(1, []), comment: { id: 3, text: 'hola' } })).toBe(true);
    expect(stillValid({ kind: 'mention', recipient: anna, task: task(1, []), comment: null })).toBe(false);
  });

  it('groups by person and sends a repeated notice once', () => {
    const rows = [
      { id: 1, kind: 'assigned', recipient: anna, actor: laia, task: task(1, [anna, pau]) },
      { id: 2, kind: 'assigned', recipient: anna, actor: laia, task: task(1, [anna, pau]) },
      { id: 3, kind: 'assigned', recipient: pau, actor: laia, task: task(1, [anna, pau]) },
      { id: 4, kind: 'mention', recipient: anna, actor: laia, task: task(2, []), comment: { id: 7, text: 'mira-ho' } },
      { id: 5, kind: 'assigned', recipient: pau, actor: laia, task: task(3, [anna]) },
    ];
    const groups = groupNotices(rows);
    expect(groups.map((g) => [g.recipient.id, g.notices.map((n) => n.id)])).toEqual([[8, [1, 4]], [9, [3]]]);
  });

  it('one notice: its own email; several: one email with the list', () => {
    const one = noticesEmail([{ kind: 'assigned', actor: laia, task: task(1, [anna]) }], 'https://x.cat/');
    expect(one.subject).toBe("[ESSTRAPIS] T'han assignat una tasca: Tasca 1");
    const many = noticesEmail([
      { kind: 'assigned', actor: laia, task: task(1, [anna]) },
      { kind: 'mention', actor: laia, task: task(2, []), comment: { text: '<b>mira</b>' } },
    ], 'https://x.cat/');
    expect(many.subject).toBe('[ESSTRAPIS] 2 novetats a les teves tasques');
    expect(many.html).toContain("Laia t'ha assignat <b>Tasca 1</b> (Bellmodel)");
    expect(many.html).toContain("Laia t'ha esmentat a <b>Tasca 2</b>: «&lt;b&gt;mira&lt;/b&gt;»");
    expect(many.html).toContain('https://x.cat/tasques?task=2');
  });

  it('knows who was taken off a task', () => {
    expect(removedFrom([anna, pau], [pau])).toEqual([anna]);
    expect(removedFrom(null, [pau])).toEqual([]);
  });
});
