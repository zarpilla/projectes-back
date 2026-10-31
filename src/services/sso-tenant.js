'use strict';

/**
 * The tenant of the tickets and docs single sign-on (issues/379).
 *
 * One SSO key is shared by every instance, so the tenant claim in the token is
 * what tells the sites which cooperative the user belongs to. It came from
 * `TICKETS_TENANT` or else the slug of `me.name`, which the entity's admin
 * edits: renaming her entity after another cooperative (and setting her email
 * to one of its users') gave her a token for that cooperative's tickets.
 *
 * Now the tenant is `TICKETS_TENANT` or, without it, the slug of the name the
 * entity had when it was first needed, kept in Strapi's core store, which no
 * API reaches. `freezeSsoTenant` keeps it at the first boot after the deploy,
 * so every instance stays on the tenant it already has on both sites.
 */
const { tenantSlug } = require('./tickets-sso');

const STORE = { type: 'core', name: 'esstrapis', key: 'sso_tenant' };

async function meName(strapi) {
  const me = await strapi.db.query('api::me.me').findOne({ select: ['name'] });
  return (me && me.name) || '';
}

/**
 * The tenant the SSO tokens carry, or '' when there is none yet. `name` is the
 * entity name, when the caller has it already.
 */
async function ssoTenant(strapi, name, env = process.env) {
  const pinned = (env.TICKETS_TENANT || '').trim();
  if (pinned) return pinned;
  const store = strapi.store(STORE);
  const kept = await store.get();
  if (typeof kept === 'string' && kept.length >= 2) return kept;
  const slug = tenantSlug(name === undefined ? await meName(strapi) : name);
  if (slug.length >= 2) await store.set({ value: slug });
  return slug;
}

/** Run-once at boot: keep the tenant the instance has today. */
async function freezeSsoTenant() {
  const tenant = await ssoTenant(global.strapi);
  global.strapi.log.info(`[freezeSsoTenant] SSO tenant: ${tenant || '(none: no entity name yet)'}`);
}

module.exports = { ssoTenant, freezeSsoTenant, STORE };
