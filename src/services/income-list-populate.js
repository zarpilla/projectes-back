'use strict';

/**
 * What the Ingressos list (EmittedInvoicesTable) reads of each emitted
 * invoice and received income, from GET /<plural>/basic (issues/330).
 *
 * The contact, projects and document type came as whole rows: the list shows
 * and exports only these columns (as the Despeses lists of issues/325). The
 * components (lines, contact_info) stay whole: the Concepte column and the
 * export read them (issues/013). The order of a document's projects is the
 * one the same populate gave before (the list shows the first).
 */
const CONTACT = { select: ['id', 'name', 'nif', 'address', 'postcode', 'city'] };
const NAMED = { select: ['id', 'name'] };

const EMITTED_INVOICE = { contact: CONTACT, projects: NAMED, lines: true, contact_info: true };
const RECEIVED_INCOME = { ...EMITTED_INVOICE, document_type: NAMED };

module.exports = { EMITTED_INVOICE, RECEIVED_INCOME };
