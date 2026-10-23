'use strict';

// issues/314: the time slot must be a fixed time or a valid range
const { slotLifecycles } = require('../../../../services/time-slot');

const { beforeCreate, beforeUpdate } = slotLifecycles('api::route.route');

module.exports = { beforeCreate, beforeUpdate };
