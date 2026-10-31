'use strict';

/**
 * The client's IP behind the proxies (issues/376).
 *
 * In production the chain is nginx → Caddy → Strapi, and Koa (`IS_PROXIED`)
 * took the leftmost `X-Forwarded-For` value. nginx *appends* to whatever the
 * client sent (`$proxy_add_x_forwarded_for`), so the leftmost value was the
 * client's choice: a new one on each request skipped the login rate limit
 * (users-permissions and the admin panel key it on `ctx.request.ip`).
 *
 * nginx also sets `X-Real-IP $remote_addr`, which it always overwrites, and
 * Caddy only listens on 127.0.0.1 and passes it on untouched. When the app is
 * proxied and that header holds an IP, it is the client's IP. Without it
 * (local, e2e, a proxy that doesn't set it) Koa's own answer stays.
 *
 * Registered first in config/middlewares.js, before the logger and the rate
 * limits read the IP.
 */
const net = require('net');

function realIp(ctx) {
  const value = ctx.get('x-real-ip');
  if (!value) return null;
  const ip = value.trim();
  return net.isIP(ip) ? ip : null;
}

module.exports = (config, { strapi }) => {
  const proxied = Boolean(strapi.config.get('server.proxy.koa'));
  return async function clientIp(ctx, next) {
    if (proxied) {
      const ip = realIp(ctx);
      if (ip) ctx.request.ip = ip;
    }
    return next();
  };
};

module.exports.realIp = realIp;
