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
      headers: '*',
    },
  },
  'strapi::poweredBy',
  'strapi::query',
  {
    // Response compression (v3 "gzip" middleware). Brotli disabled to match v3 behavior.
    name: 'strapi::responses',
    config: {
      compression: {
        br: env.bool('COMPRESSION_BROTLI', false),
      },
    },
  },
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
