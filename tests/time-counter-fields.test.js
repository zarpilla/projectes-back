'use strict';

/**
 * issues/051 (2026-10-15): a running time counter only stored its project and
 * description. The Funció (activity type), dedication type and task picked in
 * the hours dialog were lost on "Continua", so reopening the counter showed
 * them empty. The counter now stores them; the front sends their ids on
 * "Continua" and the v3-compat default populate returns them on read.
 */

const schema = require('../src/api/time-counter/content-types/time-counter/schema.json');

describe('time-counter keeps the dialog choices', () => {
  test.each([
    ['activity_type', 'api::activity-type.activity-type'],
    ['dedication_type', 'api::dedication-type.dedication-type'],
    ['task', 'api::task.task'],
  ])('%s is a relation to %s', (name, target) => {
    expect(schema.attributes[name]).toEqual({
      type: 'relation',
      relation: 'manyToOne',
      target,
    });
  });
});
