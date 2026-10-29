'use strict';

const { importSeedPermissions, importSeedRows } = require('./services/bootstrap-permissions');
const { runStartupScript } = require('./services/startup-scripts');
const { registerRolePermissionsInvalidation, clearRolePermissionsCache } = require('./services/role-permissions-cache');
const { registerLogosCacheInvalidation } = require('./services/logos-cache');
const { registerUserDeleteGuard } = require('./services/user-delete-guard');
const { seedNewDatabase } = require('./services/seed-new-database');
const { recalcZeroDocumentTotals } = require('./services/recalc-zero-document-totals');
const { ensureOrderInvoiceUniqueIndex } = require('./services/ensure-order-invoice-unique-index');
const { ensureRefsIndex } = require('./services/integrations/refs');
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
const { refreshPlannedHoursTotals } = require('./services/refresh-planned-hours-totals');
const { recountMotherFlags } = require('./services/recount-mother-flags');
const { lineVatOverType } = require('./services/line-vat-over-type');
const { backfillTransferDestinations } = require('./services/backfill-transfer-destinations');
const { repairCollectionOrderRates } = require('./services/repair-collection-order-rates');
const { refreshUnifiedOrderSnapshots } = require('./services/refresh-unified-order-snapshots');
const { frontUrlsWithoutHash } = require('./services/front-urls-without-hash');
const { frontUrlsAtRoot } = require('./services/front-urls-at-root');
const { frontUrlsInCatalan } = require('./services/front-urls-in-catalan');
const { clearQuotePreviewLinks } = require('./services/clear-quote-preview-links');
const { padFourDigitPostcodes } = require('./services/pad-four-digit-postcodes');
const { refreshUndatedOriginalTotals } = require('./services/refresh-undated-original-totals');
const { widenBudgetLineDecimals } = require('./services/widen-budget-line-decimals');
const { widenDocumentLineDecimals } = require('./services/widen-document-line-decimals');
const { repairBudgetLineTotals } = require('./services/repair-budget-line-totals');
const { fillDeliveryPointTradeNames } = require('./services/fill-delivery-point-trade-names');
const { clearDanglingMotherLinks } = require('./services/clear-dangling-mother-links');
const { removeUntypedProjectComponentLinks } = require('./services/remove-untyped-project-component-links');
const { refreshTotalHoursTotals } = require('./services/refresh-total-hours-totals');
const { addOfficialFestives } = require('./services/add-official-festives');
const { fillEmptyRelationOrder } = require('./services/relation-order');
const { fillEmptyYearVatPct } = require('./services/fill-empty-year-vat-pct');
const { migratePartnerAmounts } = require('./services/capital-contributions');
const { registerDateFieldNormalizer } = require('./services/date-fields');
const { loadTimeZone } = require('./services/time-zone');
const { recheckLateFlags } = require('./services/recheck-late-flags');
const { wrapEmailProvider } = require('./services/email-body');
const { changeLogMiddleware, registerOrderRowWrites, registerSubmissionWrites } = require('./services/change-log');
const { ensureChangeLogIndex } = require('./services/ensure-change-log-index');
const { lockIssuedInvoiceComponents } = require('./services/lock-issued-invoices');
const { registerAppPermissions } = require('./services/register-app-permissions');
const { registerReadCacheRoutes } = require('./services/read-cache/routes');
const { initReadCache } = require('./services/read-cache');
const { ensureProjectTotals } = require('./api/project/services/project-totals');
const { reconcileLegacyProjectTotals } = require('./services/reconcile-legacy-project-totals');

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
    // The app permissions are enforced on every content-API route (issues/099).
    strapi.log.info(`[app-permissions] enforced on ${registerAppPermissions(strapi)} routes`);
    // The master tables' GET routes are answered from the read cache, after the
    // app permissions (issues/307). Must come after registerAppPermissions.
    strapi.log.info(`[read-cache] on ${registerReadCacheRoutes(strapi)} routes`);
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
    // «Zona horària» (Configuració general) before any date is stored (issues/346)
    await loadTimeZone();
    registerRolePermissionsInvalidation();
    // GET /api/logos is served from memory until a logo is written (issues/308)
    registerLogosCacheInvalidation();
    // users with hours, payrolls or work periods can't be deleted (issues/050)
    registerUserDeleteGuard();
    // the orders' writes behind the document service go in their history (issues/119)
    registerOrderRowWrites();
    // VeriFactu and FACe statuses go in the emitted invoice's history (issues/161)
    registerSubmissionWrites();
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
      // issues/328: the stored totals live in project_totals; every project has
      // a row (a new tenant or an ETL rebuild gets them marked dirty). First:
      // the fixes below mark projects dirty there.
      ['ensureProjectTotals', ensureProjectTotals, { runOnce: false }],
      ['recalcZeroDocumentTotals', recalcZeroDocumentTotals, { runOnce: true }],
      // Index shape check, not a data migration: rerun on every boot so a
      // tenant rebuilt by the ETL (which recreates the composite-only unique)
      // gets the real one-invoice-per-order constraint back.
      ['ensureOrderInvoiceUniqueIndex', ensureOrderInvoiceUniqueIndex, { runOnce: false }],
      // integrations API: one order or point per (member, external_id)
      ['ensureRefsIndex', ensureRefsIndex, { runOnce: false }],
      // a record's history is read by (entity, entity_id), newest first (issues/161)
      ['ensureChangeLogIndex', ensureChangeLogIndex, { runOnce: false }],
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
      // issues/067: stored planned hours older than the current hours rules.
      ['refreshPlannedHoursTotals', refreshPlannedHoursTotals, { runOnce: true }],
      // issues/135: a project whose children are all trashed was still a mother.
      ['recountMotherFlags', recountMotherFlags, { runOnce: true }],
      // issues/143: the totals take an expense line's own VAT before its type's.
      ['lineVatOverType', lineVatOverType, { runOnce: true }],
      // issues/156: transfers saved on v5 without their route's destination.
      ['backfillTransferDestinations', backfillTransferDestinations, { runOnce: true }],
      // issues/151: open collection orders got the first route rate, whatever their route.
      ['repairCollectionOrderRates', repairCollectionOrderRates, { runOnce: true }],
      // issues/157: orders moved by Unificar (or the quick edit) kept the old point's address.
      ['refreshUnifiedOrderSnapshots', refreshUnifiedOrderSnapshots, { runOnce: true }],
      // issues/158: the front's URLs lost the "#/"; so do the links the API sends.
      ['frontUrlsWithoutHash', frontUrlsWithoutHash, { runOnce: true }],
      // issues/342: the front moved from /stats/ to the root of the site; so do the links the API sends.
      ['frontUrlsAtRoot', frontUrlsAtRoot, { runOnce: true }],
      // issues/343: the front's URLs are in Catalan; so is the password-reset link.
      ['frontUrlsInCatalan', frontUrlsInCatalan, { runOnce: true }],
      // issues/160: quotes kept a link to the front's removed quote preview as their PDF.
      ['clearQuotePreviewLinks', clearQuotePreviewLinks, { runOnce: true }],
      // issues/179: contacts loaded from a spreadsheet lost the leading zero of their postcode.
      ['padFourDigitPostcodes', padFourDigitPostcodes, { runOnce: true }],
      // issues/195: undated original-budget lines were left out of the Original totals.
      ['refreshUndatedOriginalTotals', refreshUndatedOriginalTotals, { runOnce: true }],
      // issues/194: budget lines keep 4 decimals in quantity and price (before the repair below).
      ['widenBudgetLineDecimals', widenBudgetLineDecimals, { runOnce: false }],
      // issues/270: document lines keep 4 decimals in the unit price.
      ['widenDocumentLineDecimals', widenDocumentLineDecimals, { runOnce: false }],
      // issues/194: lines whose stored total ≠ quantity × price.
      ['repairBudgetLineTotals', repairBudgetLineTotals, { runOnce: true }],
      // issues/215: delivery points saved without «Nom comercial» take their name.
      ['fillDeliveryPointTradeNames', fillDeliveryPointTradeNames, { runOnce: true }],
      // issues/206: projects migrated from v3 pointing at a deleted mother.
      ['clearDanglingMotherLinks', clearDanglingMotherLinks, { runOnce: true }],
      // issues/232: project saves linked the periodification / grant rows again without a component_type.
      ['removeUntypedProjectComponentLinks', removeUntypedProjectComponentLinks, { runOnce: true }],
      // issues/259: «Total» planned hours under ~15 days were missing from the stored totals.
      ['refreshTotalHoursTotals', refreshTotalHoursTotals, { runOnce: true }],
      // issues/310: the official holidays of 2027 (dates in the seed's FESTIVES).
      ['addOfficialFestives2027', () => addOfficialFestives(2027), { runOnce: true }],
      // issues/334: links migrated from v3 had no order: a document's projects came in any order.
      ['fillEmptyRelationOrder', fillEmptyRelationOrder, { runOnce: true }],
      // issues/338: a year with no «% IVA deduïble» is 100 % (it was 0 % in «IVA»).
      ['fillEmptyYearVatPct', fillEmptyYearVatPct, { runOnce: true }],
      // 2026-10-25: a contact's capital contribution becomes a list (date, amount,
      // comment); its old amount and date are its first one.
      ['migratePartnerAmounts', migratePartnerAmounts, { runOnce: true }],
      // issues/346: «Ruta de tarda» on the «TARDA» routes; the late marks of open orders judged again.
      ['recheckLateFlags', recheckLateFlags, { runOnce: true }],
    ];
    for (const [name, handler, options] of fixes) {
      try {
        await runStartupScript(name, handler, options);
      } catch (error) {
        strapi.log.error(`[bootstrap] startup script ${name} failed: ${error && error.message}`);
      }
    }

    // issues/328: once the previous backend of a blue/green deploy is gone,
    // the projects it changed in the old total columns are recomputed.
    const reconcileAfterMs = Number(process.env.PROJECT_TOTALS_RECONCILE_MIN || 10) * 60 * 1000;
    const reconcile = setTimeout(() => {
      runStartupScript('reconcileLegacyProjectTotals', reconcileLegacyProjectTotals, { runOnce: true }).catch(
        (error) => strapi.log.error(`[bootstrap] reconcileLegacyProjectTotals failed: ${error && error.message}`),
      );
    }, reconcileAfterMs);
    if (reconcile.unref) reconcile.unref();

    // Last: the read cache turns itself on only if change detection works
    // (issues/307). The roles' permissions kept in memory follow the same
    // detection, so a permission changed by SQL is seen too.
    await initReadCache(strapi, { onPermissionsChange: clearRolePermissionsCache });
  },
};
