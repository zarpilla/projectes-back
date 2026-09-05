'use strict';

/**
 * festive lifecycles (v5). Ported from v3 api/festive/models/festive.js.
 * Invalidates the festives cache in the project service on any write.
 */
const service = require('../../../project/services/projectCache');

module.exports = {
  async afterCreate() {
    service.setFestivesDirty(true);
  },
  async afterUpdate() {
    service.setFestivesDirty(true);
  },
  async afterDelete() {
    service.setFestivesDirty(true);
  },
};
