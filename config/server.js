module.exports = ({ env }) => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  url: env('URL', ''),
  // Behind nginx (every VPS tenant) Koa must trust X-Forwarded-Proto, otherwise
  // ctx.protocol is 'http' and the `secure` refresh-token cookie that
  // users-permissions sets on a successful login throws "Cannot send secure
  // cookie over unencrypted connection" -> 500 on POST /api/auth/local.
  // The cookie is only marked secure when NODE_ENV=production, which is why
  // local dev never hit this. Left off by default so a directly-exposed
  // instance doesn't trust forwarded headers it shouldn't.
  proxy: { koa: env.bool('IS_PROXIED', false) },
  app: {
    keys: env.array('APP_KEYS'),
  },
  webhooks: {
    populateRelations: env.bool('WEBHOOKS_POPULATE_RELATIONS', false),
  },
  // Cron tasks are defined in config/cron.js
  cron: {
    enabled: env.bool('CRON_ENABLED', true),
  },
});
