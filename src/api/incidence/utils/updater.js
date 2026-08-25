'use strict';

/**
 * Bridges the current user id from the incidence controller's update override
 * to the lifecycle's afterUpdate (v5 lifecycles have no ctx access and may
 * only export hook functions).
 */
let currentUserId = null;

module.exports = {
  setCurrentUserId(id) {
    currentUserId = id;
  },
  consumeCurrentUserId() {
    const id = currentUserId;
    currentUserId = null;
    return id;
  },
};
