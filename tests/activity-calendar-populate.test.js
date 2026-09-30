'use strict';

/**
 * "Entrada hores" (ModalBoxDedication) reopens an entry from the rows served by
 * GET /api/activities/calendar and preselects its radios from
 * `activity_type.id` (Funció), `dedication_type.id` and `task.id`.
 *
 * getForCalendar only populated project + users_permissions_user, so those keys
 * were absent and a saved Funció looked lost on reopen — the link row was in
 * activities_activity_type_lnk all along. v3's find() populated every
 * first-level relation, so every relation on activity must be populated here.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'api', 'activity');
const controller = fs.readFileSync(path.join(SRC, 'controllers', 'activity.js'), 'utf8');
const schema = JSON.parse(
  fs.readFileSync(path.join(SRC, 'content-types', 'activity', 'schema.json'), 'utf8')
);

function calendarPopulate() {
  const start = controller.indexOf('async getForCalendar');
  const end = controller.indexOf('async totalByDay');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const match = controller.slice(start, end).match(/populate:\s*\{([\s\S]*?)\}/);
  expect(match).not.toBeNull();
  return match[1];
}

describe('activities/calendar populate', () => {
  const relations = Object.entries(schema.attributes)
    .filter(([, a]) => a.type === 'relation')
    .map(([name]) => name);

  it('finds the activity relations — guards the extraction', () => {
    expect(relations).toEqual(
      expect.arrayContaining(['activity_type', 'dedication_type', 'task', 'project'])
    );
  });

  it.each(relations)('populates %s', (name) => {
    expect(calendarPopulate()).toMatch(new RegExp(`\\b${name}:\\s*true`));
  });
});
