// v5 middleware stack. Ported from v3 config/middleware.js (gzip enabled, brotli off).
// CORS is left at the v5 default (open in dev); tighten via env in production.
module.exports = ({ env }) => [
  'strapi::logger',
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentsecurity: false,
    },
  },
  {
    name: 'strapi::cors',
    config: {
      // Explicit list, not '*': the frontend sends credentials (refresh-token
      // cookie) and browsers treat a wildcard Allow-Headers literally on
      // credentialed requests, failing the preflight for Authorization etc.
      headers: ['Content-Type', 'Authorization', 'Origin', 'Accept', 'X-Requested-With'],
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
  'strapi::session',
  'strapi::favicon',
  // Must precede strapi::public: uploads are served straight off disk, and that
  // exposed the PKCS#12 certificate to anonymous download. See the middleware.
  'global::block-key-material',
  'strapi::public',
  // v3 -> v5 REST transport compat (P9): numeric id -> documentId on core
  // routes, and v3's default first-level populate. Must run before the router.
  'global::v3-compat',
];
