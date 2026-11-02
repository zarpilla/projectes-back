'use strict';

/**
 * `api-key` policy: the integrations API (api/integration) is public for
 * Strapi (`auth: false`, no JWT) and authenticated here by the key in the
 * `x-api-key` header (services/integrations/api-keys.js).
 *
 * The key's user must exist, not be blocked and have the `orders` permission:
 * the API writes her orders and delivery points with her rules. She is put on
 * `state.integration`, not `state.user`, so the app-permissions middleware
 * (which would refuse these routes to a member) leaves the request alone; the
 * controller sets `state.user` itself for the order history.
 *
 * At most RATE_LIMIT requests a minute per key (in memory: one process per
 * tenant).
 */
const { errors } = require('@strapi/utils');
const { authenticateKey } = require('../services/integrations/api-keys');
const { appPermissionsOf } = require('../services/app-permissions');

/**
 * A 401 that keeps its message. Strapi's authorize step wraps the policies and
 * turns any UnauthorizedError into a bare «Unauthorized»; an exposed client
 * error is answered as it is (middlewares/quiet-client-errors.js).
 */
class KeyRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnauthorizedError';
    this.status = 401;
    this.expose = true;
  }
}

const RATE_LIMIT = 60;
const WINDOW_MS = 60 * 1000;
const windows = new Map();

function overLimit(keyId, now = Date.now()) {
  const current = windows.get(keyId);
  if (!current || now - current.start >= WINDOW_MS) {
    windows.set(keyId, { start: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > RATE_LIMIT;
}

module.exports = async (policyContext, _config, { strapi }) => {
  const header = policyContext.request && policyContext.request.header;
  const key = header && (header['x-api-key'] || '').trim();
  if (!key) throw new KeyRefused("Falta la clau d'API (capçalera x-api-key)");

  const row = await authenticateKey(key);
  if (!row) throw new KeyRefused("La clau d'API no és vàlida o s'ha revocat");

  if (overLimit(row.id)) {
    throw new errors.RateLimitError(`Massa peticions: com a màxim ${RATE_LIMIT} per minut`);
  }

  const user = await strapi.db
    .query('plugin::users-permissions.user')
    .findOne({ where: { id: row.user_id }, select: ['id', 'username', 'email', 'blocked'] });
  if (!user || user.blocked) throw new KeyRefused("La usuària de la clau d'API està bloquejada");

  const permissions = await appPermissionsOf(user.id, strapi);
  if (!permissions.includes('orders')) {
    throw new errors.PolicyError("La usuària de la clau d'API no té el permís de comandes");
  }

  policyContext.state.integration = {
    user: { id: user.id, username: user.username, email: user.email },
    permissions,
    key: { id: row.id, prefix: row.prefix },
  };
  return true;
};

module.exports.overLimit = overLimit;
module.exports.KeyRefused = KeyRefused;
module.exports.RATE_LIMIT = RATE_LIMIT;
