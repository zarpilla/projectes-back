'use strict';

/**
 * bank-movement custom routes: «Tresoreria › Conciliació» (issues/413).
 * The `01-` prefix loads them before the core router, whose
 * `/bank-movements/:id` would otherwise shadow `/bank-movements/reconciliation`.
 */
module.exports = {
  routes: [
    { method: 'POST', path: '/bank-movements/import', handler: 'bank-movement.import' },
    { method: 'GET', path: '/bank-movements/reconciliation', handler: 'bank-movement.reconciliation' },
    { method: 'POST', path: '/bank-movements/auto', handler: 'bank-movement.auto' },
    { method: 'GET', path: '/bank-movements/:id/candidates', handler: 'bank-movement.candidates' },
    { method: 'POST', path: '/bank-movements/:id/accept', handler: 'bank-movement.accept' },
    { method: 'POST', path: '/bank-movements/:id/create', handler: 'bank-movement.createRecord' },
    { method: 'POST', path: '/bank-movements/:id/transfer', handler: 'bank-movement.transfer' },
    { method: 'POST', path: '/bank-movements/:id/ignore', handler: 'bank-movement.ignore' },
    { method: 'POST', path: '/bank-movements/:id/undo', handler: 'bank-movement.undo' },
  ],
};
