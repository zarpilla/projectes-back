'use strict';

/**
 * strategy lifecycles (v5). Ported from v3 api/strategy/models/strategy.js.
 * Maintains the denormalized code_name = "code - name".
 */
module.exports = {
  async beforeCreate(event) {
    calculateCodeName(event.data);
  },
  async beforeUpdate(event) {
    calculateCodeName(event.data);
  },
};

function calculateCodeName(data) {
  data.code_name = `${data.code} - ${data.name}`;
}
