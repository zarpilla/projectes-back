'use strict';

/**
 * Encrypts the secret fields on write. See services/secret-crypto.js for why
 * these cannot be hashed and what the encryption does and does not protect.
 */
const { encryptSecretFields } = require('../../../../services/secret-crypto');
const { setTimeZone } = require('../../../../services/time-zone');

const UID = 'api::me.me';

module.exports = {
  async beforeCreate(event) {
    encryptSecretFields(event.params.data, UID);
  },
  async beforeUpdate(event) {
    encryptSecretFields(event.params.data, UID);
  },
  // «Zona horària» applies from the next request on (issues/346)
  async afterCreate(event) {
    if (event.result && 'time_zone' in event.result) setTimeZone(event.result.time_zone);
  },
  async afterUpdate(event) {
    if (event.result && 'time_zone' in event.result) setTimeZone(event.result.time_zone);
  },
};
