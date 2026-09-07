'use strict';

/**
 * Encrypts the secret fields on write. See services/secret-crypto.js for why
 * these cannot be hashed and what the encryption does and does not protect.
 */
const { encryptSecretFields } = require('../../../../services/secret-crypto');

const UID = 'api::me.me';

module.exports = {
  async beforeCreate(event) {
    encryptSecretFields(event.params.data, UID);
  },
  async beforeUpdate(event) {
    encryptSecretFields(event.params.data, UID);
  },
};
