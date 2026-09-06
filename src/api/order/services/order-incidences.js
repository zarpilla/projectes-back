'use strict';
/* global strapi */

/**
 * Order incidences: create/update the incidence rows an order form submits.
 *
 * Lifted out of the order lifecycles because v5 validates relation payloads
 * BEFORE any lifecycle runs. `incidences` arrives from OrdersForm as full
 * objects to create, not as ids, so the Document Service rejects the write
 * with 400 "Invalid relations" and the lifecycle's `delete data.incidences`
 * never gets the chance to run. The order controller therefore pulls the
 * array off the request body and calls this afterwards.
 *
 * Ported from v3 api/orders/models/orders.js processIncidences.
 */

const processIncidences = async (orderId, incidences, trackingUser) => {
  try {
    // Get existing incidences for this order
    const existingIncidences = await strapi.db
      .query('api::incidence.incidence')
      .findMany({ where: { order: orderId } });

    // Create a map of existing incidences by ID for quick lookup
    const existingMap = new Map(existingIncidences.map((inc) => [inc.id, inc]));
    const processedIds = new Set();

    // Process each incidence from the form
    for (const incidence of incidences) {
      if (incidence.id) {
        // Update existing incidence
        processedIds.add(incidence.id);
        const existing = existingMap.get(incidence.id);

        if (existing) {
          const updateData = {
            description: incidence.description,
            state: incidence.state,
          };

          // If changing to closed state and not already closed, set closed_date and closed_user
          if (incidence.state === 'closed' && existing.state !== 'closed') {
            updateData.closed_date = new Date();
            if (trackingUser) {
              updateData.closed_user = trackingUser.id;
            }
          }

          await strapi.db
            .query('api::incidence.incidence')
            .update({ where: { id: incidence.id }, data: updateData });
        }
      } else {
        // Create new incidence
        const createData = {
          order: orderId,
          description: incidence.description,
          state: incidence.state || 'open',
        };

        if (trackingUser) {
          createData.created_user = trackingUser.id;
        }

        // If creating as closed, set closed_date and closed_user
        if (createData.state === 'closed') {
          createData.closed_date = new Date();
          if (trackingUser) {
            createData.closed_user = trackingUser.id;
          }
        }

        // v5's db.query create takes { data }; v3 took the flat object.
        const newIncidence = await strapi.db
          .query('api::incidence.incidence')
          .create({ data: createData });
        processedIds.add(newIncidence.id);
      }
    }

    // Note: We're not deleting incidences that are not in the list
    // If you want to delete removed incidences, uncomment the code below:
    /*
    // Delete incidences that were removed from the list
    for (const existing of existingIncidences) {
      if (!processedIds.has(existing.id)) {
        await strapi.db.query('api::incidence.incidence').delete({ id: existing.id });
      }
    }
    */
  } catch (error) {
    console.error('Error processing incidences:', error);
    throw error;
  }
};

module.exports = { processIncidences };
