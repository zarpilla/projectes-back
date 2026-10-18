'use strict';

/**
 * city CUSTOM routes. The `01-` prefix loads them before the core router's
 * `/cities/:id`, which would otherwise take `/cities/postcodes`.
 */
module.exports = {
  routes: [
    // issues/182: the delivery point form fills the CP from the town
    {
      method: 'GET',
      path: '/cities/postcodes',
      handler: 'city.postcodes',
    },
  ],
};
