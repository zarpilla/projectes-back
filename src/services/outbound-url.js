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

/** The eight 16-bit groups of an IPv6 address (dotted IPv4 tail included), or null. */
function ipv6Groups(ip) {
  let text = String(ip).toLowerCase().replace(/%.*$/, '');
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const bytes = dotted[1].split('.').map(Number);
    if (bytes.some((b) => b > 255)) return null;
    text = text.slice(0, -dotted[1].length) + `${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4From = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Whether `ip` is loopback, private, link-local or otherwise not public. An
 * IPv6 address that carries an IPv4 one is judged by it, in every notation
 * (issues/394: `[::ffff:7f00:1]`, how the URL parser writes `::ffff:127.0.0.1`,
 * passed): IPv4-mapped and -compatible, NAT64 (64:ff9b::/96) and 6to4 (2002::/16).
 */
function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return ipv4Private(ip);
  if (family !== 6) return true;
  const g = ipv6Groups(ip);
  if (!g) return true;
  const zeroUpTo = (n) => g.slice(0, n).every((x) => x === 0);
  if (zeroUpTo(5) && (g[5] === 0xffff || g[5] === 0)) return ipv4Private(v4From(g[6], g[7])); // mapped, compatible, ::, ::1
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return ipv4Private(v4From(g[6], g[7]));
  if (g[0] === 0x2002) return ipv4Private(v4From(g[1], g[2]));
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true; // Teredo, documentation
  if (g[0] === 0x100 && zeroUpTo(4)) return true; // discard
  // unique local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;
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
  const log = (global.strapi && global.strapi.log) || console;
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

/**
 * The text of an admin-set calendar URL (user.ical / me.ical), through the same
 * checks as the other admin-configured calls (issues/394): node-ical fetched it
 * with no address check.
 */
async function fetchOutboundText(value) {
  // eslint-disable-next-line global-require
  const axios = require('axios');
  const url = checkBaseUrl(value);
  const res = await axios.get(url, { ...outboundAxiosOptions(), responseType: 'text', timeout: 15000, maxContentLength: 5 * 1024 * 1024 });
  return typeof res.data === 'string' ? res.data : String(res.data);
}

module.exports = {
  fetchOutboundText,
  OutboundUrlError,
  upstreamError,
  isPrivateAddress,
  publicLookup,
  checkBaseUrl,
  publicHttpsAgent,
  outboundAxiosOptions,
};
