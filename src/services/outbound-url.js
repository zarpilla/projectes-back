'use strict';

/**
 * Outbound calls to URLs an entity admin writes in Configuració (issues/378):
 * DIR3, the invoice parser and the FACe endpoints.
 *
 * The backends run with `network_mode: host`, so `http://127.0.0.1:2019` is
 * the VPS itself (Caddy's admin API with every tenant's config, Loki…), and
 * the answer was sent back to her. Now these calls:
 *   - go only to https URLs (every configured one is),
 *   - connect only to public addresses: the check runs on the address the
 *     socket really connects to (the agent's `lookup`), so a name that
 *     resolves to a private address, now or after the check, is refused,
 *   - don't follow redirects.
 * `OUTBOUND_ALLOW_PRIVATE=true` lifts the address check (local development
 * against a parser on localhost).
 */
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

class OutboundUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OutboundUrlError';
  }
}

const allowPrivate = () => /^(1|true|yes)$/i.test(String(process.env.OUTBOUND_ALLOW_PRIVATE || ''));

function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Whether `ip` is loopback, private, link-local or otherwise not public. */
function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return ipv4Private(ip);
  if (family !== 6) return true;
  const lower = ip.toLowerCase();
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) || /^::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4Private(mapped[1]);
  if (lower === '::' || lower === '::1') return true;
  return /^(f[cd]|fe[89ab]|ff)/.test(lower); // unique local, link-local, multicast
}

/** A `lookup` for agents that refuses private addresses (issues/378). */
function publicLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!allowPrivate() && addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(new OutboundUrlError(`${hostname} is not a public address`));
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

/** The base URL, checked: https with a host, no credentials. Throws OutboundUrlError. */
function checkBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new OutboundUrlError('The URL is not valid');
  }
  const local = allowPrivate() && url.protocol === 'http:';
  if ((url.protocol !== 'https:' && !local) || !url.hostname || url.username || url.password) {
    throw new OutboundUrlError('Only https URLs are allowed');
  }
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && !allowPrivate()) {
    if (isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
      throw new OutboundUrlError(`${url.hostname} is not a public address`);
    }
  }
  return url.toString().replace(/\/+$/, '');
}

/** An https agent that connects only to public addresses. */
function publicHttpsAgent(options = {}) {
  return new https.Agent({ ...options, lookup: publicLookup });
}

/** axios options for a call to an admin-configured URL. */
function outboundAxiosOptions(options = {}) {
  return {
    httpsAgent: options.httpsAgent || publicHttpsAgent(),
    httpAgent: new http.Agent({ lookup: publicLookup }),
    maxRedirects: 0,
  };
}

/**
 * Answers a failed outbound call without echoing the upstream body (it could
 * be an internal service's) and logs only its status and message: the axios
 * error carries the request config, with the decrypted API key (issues/378).
 */
function upstreamError(ctx, error, what, fallback) {
  const status = error && error.response && error.response.status;
  const log = (typeof strapi !== 'undefined' && strapi.log) || console;
  log.error(`[outbound] ${what}: ${status ? `HTTP ${status}` : ''} ${(error && error.message) || error}`.trim());
  if (error instanceof OutboundUrlError) return ctx.badRequest(error.message);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    const data = error.response.data;
    const upstream = data && typeof data === 'object' && typeof data.message === 'string' ? data.message : '';
    const message = upstream.slice(0, 300) || fallback;
    return ctx.send({ data: null, error: { status, name: 'UpstreamError', message }, message }, status);
  }
  return ctx.internalServerError(fallback);
}

module.exports = {
  OutboundUrlError,
  upstreamError,
  isPrivateAddress,
  publicLookup,
  checkBaseUrl,
  publicHttpsAgent,
  outboundAxiosOptions,
};
