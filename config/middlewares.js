// v5 middleware stack. Ported from v3 config/middleware.js (gzip enabled, brotli off).
// CORS: the instance's own front end only (src/services/cors-origins.js, issues/383).
module.exports = ({ env }) => [
  // The client's IP from nginx's X-Real-IP, not the spoofable leftmost
  // X-Forwarded-For (issues/376). First, so the logger and rate limits see it.
  'global::client-ip',
  // strapi::logger's line without the values people type (issues/394)
  'global::request-log',
  'strapi::errors',
  // 4xx http-errors from koa-static (bot scans) answered without an error log
  // (issues/052). Must come right after strapi::errors.
  'global::quiet-client-errors',
  // Strapi's defaults, CSP included: /uploads is served from the app's own
  // origin, so its `script-src 'self'` must stay (issues/401; the old
  // `contentsecurity: false` here was no helmet option and did nothing).
  'strapi::security',
  {
    name: 'strapi::cors',
    config: {
      // Explicit list, not '*': the frontend sends credentials (refresh-token
      // cookie) and browsers treat a wildcard Allow-Headers literally on
      // credentialed requests, failing the preflight for Authorization etc.
      headers: ['Content-Type', 'Authorization', 'Origin', 'Accept', 'X-Requested-With'],
      // only the instance's own front end, not any origin (issues/383)
      origin: (ctx) => require('../src/services/cors-origins').corsOrigin(ctx),
    },
  },
  'strapi::poweredBy',
  'strapi::query',
  {
    // Response compression (v3 "gzip" middleware). Until issues/016 this config
    // sat on strapi::responses, which does not compress anything in v5, and
    // nginx only gzips text/html — so every JSON answer (485 KB for a large
    // project, several MB for the lists) crossed the network uncompressed.
    // Brotli stays off: koa-compress runs it at maximum quality, far too slow
    // for dynamic answers.
    name: 'strapi::compression',
    config: {
      br: env.bool('COMPRESSION_BROTLI', false),
    },
  },
  'strapi::responses',
  'strapi::body',
  // Clients can't send the one-shot «Modificable» bypass. Right after the body parser.
  'global::strip-unlock-flag',
  // no HTML, XML or script files among uploads (issues/395)
  'global::upload-file-types',
  'strapi::session',
  'strapi::favicon',
  // Must precede strapi::public: uploads are served straight off disk, and that
  // exposed the PKCS#12 certificate to anonymous download. See the middleware.
  'global::block-key-material',
  // No API answer carries a user's password hash or tokens (issues/028).
  'global::strip-user-secrets',
  // HTML/scripts/SVG already under /uploads are never served as active content (issues/395)
  'global::uploads-inert',
  'strapi::public',
  // v3 -> v5 REST transport compat (P9): numeric id -> documentId on core
  // routes, and v3's default first-level populate. Must run before the router.
  'global::v3-compat',
];
