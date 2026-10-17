'use strict';

/**
 * The task digest skips done tasks. "Done" is the last state by order, as on the
 * front; it was the id 3 (on Diligència "Revisar" sits between En procés and
 * Acabades, so a reordering would have broken the id rule).
 */
const { doneStateId } = require('../src/api/task/services/done-state');

describe('task done state', () => {
  it('is the last state by order', () => {
    expect(doneStateId([{ id: 1, order: 0 }, { id: 2, order: 1 }, { id: 3, order: 4 }, { id: 4, order: 2 }])).toBe(3);
    expect(doneStateId([{ id: 7, order: 1 }, { id: 3, order: 0 }])).toBe(7);
  });
  it('is none with fewer than two states', () => {
    expect(doneStateId([{ id: 1, order: 0 }])).toBe(null);
    expect(doneStateId([])).toBe(null);
  });
});
