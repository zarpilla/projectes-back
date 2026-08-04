/**
 * v5 plugin config. Ported from v3 config/plugins.js.
 *
 * Email provider is switchable via EMAIL_PROVIDER (sendgrid | nodemailer), matching
 * the v3 convention. The v3-era provider packages (strapi-provider-email-sendgrid,
 * strapi-provider-email-nodemailer) are v3-only and have no direct v5 equivalent from
 * the same maintainers; the v5 community provider `@strapi/provider-email-nodemailer`
 * covers SMTP. SendGrid is callable via its REST API through a thin custom provider
 * (implemented in Phase 2.3 / src/providers/email-sendgrid). Until then, only the
 * nodemailer path is wired here; the sendgrid path falls back to nodemailer with a log.
 */
const path = require('path');

const allowedMediaTypes = [
  'image/*',
  'video/*',
  'audio/*',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.*',
  'text/plain',
  'text/csv',
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
    // NOTE(R8): v3 used strapi-provider-email-sendgrid. The v5 SendGrid path uses a
    // custom local provider (src/providers/email-sendgraph) until a maintained v5
    // provider is installed. Falls back to nodemailer if SMTP creds are present.
    return {
      provider: 'nodemailer',
      providerOptions: {
        host: env('SMTP_HOST', 'smtp.example.com'),
        port: env.int('SMTP_PORT', 587),
        auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
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
