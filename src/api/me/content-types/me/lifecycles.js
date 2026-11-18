'use strict';

/**
 * Encrypts the secret fields on write. See services/secret-crypto.js for why
 * these cannot be hashed and what the encryption does and does not protect.
 */
const { encryptSecretFields } = require('../../../../services/secret-crypto');
const { setTimeZone } = require('../../../../services/time-zone');
const { dropTokensOfMovedUrls } = require('../../../../services/integration-tokens');
const { pctChanged, remarkProjects, newMePct, currentMePct } = require('../../../../services/deductible-vat-change');

const UID = 'api::me.me';

module.exports = {
  async beforeCreate(event) {
    encryptSecretFields(event.params.data, UID);
  },
  async beforeUpdate(event) {
    await dropTokensOfMovedUrls(event.params);
    encryptSecretFields(event.params.data, UID);
    // Configuració's «% IVA deduïble» before the save (issues/440)
    if (newMePct(event.params.data) !== undefined) {
      event.state = { ...(event.state || {}), deductibleVatPct: await currentMePct() };
    }
  },
  // «Zona horària» applies from the next request on (issues/346)
  async afterCreate(event) {
    if (event.result && 'time_zone' in event.result) setTimeZone(event.result.time_zone);
  },
  async afterUpdate(event) {
    if (event.result && 'time_zone' in event.result) setTimeZone(event.result.time_zone);
    // the years without a % of their own use it: recompute the projects (issues/440)
    const pct = newMePct(event.params && event.params.data);
    if (pct !== undefined && event.state && 'deductibleVatPct' in event.state && pctChanged(event.state.deductibleVatPct, pct)) {
      await remarkProjects('«% IVA deduïble» of Configuració');
    }
  },
};
