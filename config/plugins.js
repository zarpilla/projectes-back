/**
 * v5 plugin config. Ported from v3 config/plugins.js.
 *
 * Email provider is switchable via EMAIL_PROVIDER (sendgrid | nodemailer), matching
 * the v3 convention. The v3-era provider packages (strapi-provider-email-sendgrid,
 * strapi-provider-email-nodemailer) are v3-only and have no direct v5 equivalent from
 * the same maintainers; the v5 community provider `@strapi/provider-email-nodemailer`
 * covers SMTP, and SendGrid is served by the local custom provider
 * (src/providers/email-sendgrid, P8.4) via the SendGrid REST API.
 */
const path = require('path');

// PKCS#12 keystores, uploaded into me.face_certificate and verifactu.certificate.
// Both e-invoicing paths consume this format and only this format —
// https.Agent({ pfx }), forge.pkcs12 and `openssl pkcs12` — so the list stays
// narrow rather than opening up certificates generally. `.p12` and `.pfx` both
// resolve to application/x-pkcs12; application/pkcs12 is the IANA name that
// some clients send instead.
const allowedCertificateTypes = ['application/x-pkcs12', 'application/pkcs12'];

const allowedMediaTypes = [
  'image/*',
  'video/*',
  'audio/*',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.*',
  'text/plain',
  'text/csv',
  ...allowedCertificateTypes,
];

const deniedExecutableTypes = [
  'application/vnd.microsoft.portable-executable',
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-dosexec',
  'application/x-sh',
  'text/x-shellscript',
  'application/x-mach-binary',
];

function emailProviderConfig(env) {
  const provider = env('EMAIL_PROVIDER', 'nodemailer');
  const defaultFrom = env('EMAIL_FROM', 'no-reply@example.com');

  if (provider === 'sendgrid') {
    // NOTE(R8): v3 used strapi-provider-email-sendgrid (v3-only package).
    // The v5 SendGrid path is a local custom provider (src/providers/email-sendgrid,
    // ported in P8.4) that calls the SendGrid v3 REST API with the same options.
    return {
      provider: require('../src/providers/email-sendgrid'),
      providerOptions: {
        apiKey: env('SENDGRID_API_KEY'),
      },
      settings: { defaultFrom, defaultReplyTo: defaultFrom },
    };
  }

  // default: nodemailer (SMTP) — matches production deployment
  return {
    provider: 'nodemailer',
    providerOptions: {
      host: env('SMTP_HOST', 'smtp.example.com'),
      port: env.int('SMTP_PORT', 465),
      auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
    },
    settings: { defaultFrom, defaultReplyTo: defaultFrom },
  };
}

module.exports = ({ env }) => ({
  email: emailProviderConfig(env),
  'users-permissions': {
    config: {
      jwtManagement: 'refresh',
      sessions: {
        httpOnly: true,
      },
    },
  },
  upload: {
    config: {
      // Local provider (default). v3 also used local; production stores files on disk
      // under public/uploads and serves them via nginx. Multi-tenant: each PM2 instance
      // has its own uploads dir.
      providerOptions: {
        localServer: {
          path: path.resolve(__dirname, '..', 'public', 'uploads'),
        },
      },
      security: {
        allowedTypes: allowedMediaTypes,
        deniedTypes: deniedExecutableTypes,
      },
    },
  },
});
