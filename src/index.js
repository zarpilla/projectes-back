'use strict';

const { importSeedPermissions, importSeedRows } = require('./services/bootstrap-permissions');
const { runStartupScript } = require('./services/startup-scripts');
const { registerRolePermissionsInvalidation } = require('./services/role-permissions-cache');
const { registerUserDeleteGuard } = require('./services/user-delete-guard');
const { seedNewDatabase } = require('./services/seed-new-database');
const { recalcZeroDocumentTotals } = require('./services/recalc-zero-document-totals');
const { ensureOrderInvoiceUniqueIndex } = require('./services/ensure-order-invoice-unique-index');
const { normalizeComponentTypes } = require('./services/normalize-component-types');
const { backfillActivityCosts } = require('./services/backfill-activity-costs');
const { mergeInvalidPeriodificationYears } = require('./services/merge-invalid-periodification-years');
const { ensureResetPasswordUrl } = require('./services/ensure-reset-password-url');
const { ensureAuthEmailTemplates } = require('./services/ensure-auth-email-templates');
const { recalcZeroQuoteTotals } = require('./services/recalc-zero-quote-totals');
const { zeroVatExpenseTypes } = require('./services/zero-vat-expense-types');
const { recalcMismatchedDocumentTotals } = require('./services/recalc-mismatched-document-totals');
const { refreshAllLineWarnings } = require('./services/refresh-line-warnings');
const { mergeDuplicateCities } = require('./services/merge-duplicate-cities');
const { registerDateFieldNormalizer } = require('./services/date-fields');
const { wrapEmailProvider } = require('./services/email-body');
const { changeLogMiddleware } = require('./services/change-log');
const { lockIssuedInvoiceComponents } = require('./services/lock-issued-invoices');

module.exports = {
  /**
   * An asynchronous register function that runs before your application is
   * initialized. Used to register hooks, services, etc.
   */
  register({ strapi }) {
    // Change log of emitted/received invoices (issues/001).
    strapi.documents.use(changeLogMiddleware);
    // Issued invoices keep their lines and client's details (issues/023, issues/035).
    strapi.documents.use(lockIssuedInvoiceComponents);
  },

  /**
   * An asynchronous bootstrap function that runs before your application gets
   * started.
   *
   * Ported from the v3 config/functions/bootstrap.js (3,897 LOC):
   *  - P6.1: the public/authenticated permission matrix (importSeedPermissions)
   *  - P6.3: seed rows — verifactu settings, declarations, default bank account
   *  - P6.2: the 14 v3 runOnce backfills are NOT re-implemented here — they are
   *    one-time data migrations and belong to the Phase 7 ETL (the clean-room
   *    build loads already-corrected data).
   *  - v5 data fixes: one-time repairs of rows written wrongly by v5 itself,
   *    through the ported v3 startup-scripts guard (services/startup-scripts).
   */
  async bootstrap({ strapi }) {
    registerDateFieldNormalizer();
    registerRolePermissionsInvalidation();
    // users with hours, payrolls or work periods can't be deleted (issues/050)
    registerUserDeleteGuard();
    wrapEmailProvider(strapi);

    // A brand-new database gets its catalogs, settings and home menu (what used
    // to come from restoring the empty `buida` tenant). Existing databases are
    // left alone. Before the seed rows below, so the default bank account they
    // create is wired into the settings record.
    try {
      await runStartupScript('seedNewDatabase', seedNewDatabase, { runOnce: true });
    } catch (error) {
      strapi.log.error(`[bootstrap] startup script seedNewDatabase failed: ${error && error.message}`);
    }

    try {
      await importSeedPermissions();
      await importSeedRows();
      strapi.log.info('[bootstrap] permissions + seed rows ready');
    } catch (error) {
      strapi.log.error(`[bootstrap] failed: ${error && error.message}`);
    }

    // Kept apart from the seed block: a failed data fix must not read as a
    // failed permission seed, nor stop the next fix from running.
    const fixes = [
      ['recalcZeroDocumentTotals', recalcZeroDocumentTotals, { runOnce: true }],
      // Index shape check, not a data migration: rerun on every boot so a
      // tenant rebuilt by the ETL (which recreates the composite-only unique)
      // gets the real one-invoice-per-order constraint back.
      ['ensureOrderInvoiceUniqueIndex', ensureOrderInvoiceUniqueIndex, { runOnce: false }],
      // Rerun on every boot for the same reason: the ETL used to copy v3's
      // component_type spelling, which duplicated component rows on save.
      ['normalizeComponentTypes', normalizeComponentTypes, { runOnce: false }],
      // issues/012: price unpriced activities and recompute "Hores executades".
      ['backfillActivityCosts', backfillActivityCosts, { runOnce: true }],
      // issues/015: periodification rows saved as "Invalid date" join the undated 9999 row.
      ['mergeInvalidPeriodificationYears', mergeInvalidPeriodificationYears, { runOnce: true }],
      // issues/021: the password-reset e-mail needs the front's URL. Rerun on every
      // boot: it only fills the setting when empty, so setting the env var later works.
      ['ensureResetPasswordUrl', ensureResetPasswordUrl, { runOnce: false }],
      // issues/021: the SMTP accounts refuse Strapi's default sender (no-reply@strapi.io);
      // also puts the e-mails' text in Catalan.
      ['ensureAuthEmailTemplates', ensureAuthEmailTemplates, { runOnce: false }],
      // issues/022: quotes saved on v5 had every total at 0.
      ['recalcZeroQuoteTotals', recalcZeroQuoteTotals, { runOnce: true }],
      // issues/033: 0 % expense types were budgeted at 21 % VAT.
      ['zeroVatExpenseTypes', zeroVatExpenseTypes, { runOnce: true }],
      // issues/045: documents saved while issues/002 doubled their lines kept the doubled total.
      ['recalcMismatchedDocumentTotals', recalcMismatchedDocumentTotals, { runOnce: true }],
      // issues/094: the «Imports diferents» warning went stale when project lines changed.
      ['refreshAllLineWarnings', refreshAllLineWarnings, { runOnce: true }],
      // issues/093: «Barcelona» / «Barcelona », «Manlleu» / «Manlleu » and «Cabrils» existed twice.
      ['mergeDuplicateCities', mergeDuplicateCities, { runOnce: true }],
    ];
    for (const [name, handler, options] of fixes) {
      try {
        await runStartupScript(name, handler, options);
      } catch (error) {
        strapi.log.error(`[bootstrap] startup script ${name} failed: ${error && error.message}`);
      }
    }
  },
};
