'use strict';

/**
 * route-rate lifecycles (issues/139).
 *
 * A rate has two sets of tiers: the old one (less15 / less30 / additional30)
 * and the current one (less10, more10 … from50to60, additional60,
 * pickup_point), chosen by `ratev2`. Only the current one is in use and only
 * its fields are shown in «Taules auxiliars › Tarifes de ruta», so every rate
 * that is created or edited is a ratev2 one: otherwise a new rate (ratev2
 * empty) would be priced with the old tiers, which the form doesn't show.
 */
module.exports = {
  beforeCreate(event) {
    event.params.data.ratev2 = true;
  },
  beforeUpdate(event) {
    event.params.data.ratev2 = true;
  },
};
