'use strict';

/**
 * issues/328: `dirty` lives in project_totals and the startup scripts mark
 * projects through project-totals' markDirty. Tests that record "what was
 * marked dirty" replace it with `record(ids)`. Call after jest.resetModules()
 * and before requiring the code under test.
 */
function mockMarkDirty(record) {
  jest.doMock('../../src/api/project/services/project-totals', () => {
    const actual = jest.requireActual('../../src/api/project/services/project-totals');
    return {
      ...actual,
      markDirty: jest.fn(async (ids) => {
        const list = Array.isArray(ids) ? ids : [ids];
        record(list);
        return list.length;
      }),
    };
  });
}

module.exports = { mockMarkDirty };
