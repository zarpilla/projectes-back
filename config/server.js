// { '0 3 * * *': { task } } → { '0 3 * * *': { task, options: { rule: '0 3 * * *' } } }
function withRules(tasks) {
  return Object.fromEntries(Object.entries(tasks).map(([rule, value]) =>
    [rule, typeof value === 'function' || (value.options && value.options.rule) ? value : { ...value, options: { ...(value.options || {}), rule } }]));
}

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
  // Cron tasks are defined in config/cron.js. Strapi 5 only runs the ones listed
  // here (server.cron.tasks), and a { task } entry is scheduled with its
  // options.rule, not with its key: without both, no job ran (daily task digest,
  // totals refresh, FACe status and retries).
  cron: {
    enabled: env.bool('CRON_ENABLED', true),
    tasks: withRules(require('./cron')),
  },
});
