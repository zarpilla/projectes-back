'use strict';
/* global strapi */

/**
 * Document-service middleware (issues/023, issues/035): an update can't change
 * the lines or the client's details (`contact_info`) of an issued (`real`)
 * emitted invoice.
 *
 * emitted-invoice beforeUpdate pins the locked fields to their stored values,
 * but that db lifecycle runs after the document service has already replaced
 * the components: an update sending new lines (without component ids) deleted
 * the stored line and left the invoice linked to a missing row. Dropping
 * `lines` here, before the document service sees them, keeps them intact.
 * The form sends the lines with their ids and saves issued invoices as before.
 * `contact_info` is a component too, so it is locked the same way.
 */

const UID = 'api::emitted-invoice.emitted-invoice';
const LOCKED = ['lines', 'contact_info'];

function whereFromParams(params) {
  if (params.documentId) return { documentId: params.documentId };
  if (params.id) return { id: params.id };
  return null;
}

async function lockIssuedInvoiceComponents(context, next) {
  const { uid, action, params } = context;
  const data = params && params.data;
  if (uid === UID && action === 'update' && data && LOCKED.some((field) => data[field] !== undefined)) {
    const where = whereFromParams(params);
    const stored = where ? await strapi.db.query(UID).findOne({ where, select: ['id', 'state'] }) : null;
    if (stored && stored.state === 'real') {
      for (const field of LOCKED) delete data[field];
    }
  }
  return next();
}

module.exports = { lockIssuedInvoiceComponents };
