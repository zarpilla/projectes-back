# projectes-v5 — Strapi v3 → v5 migration

Clean-room rebuild of the `projectes` backend (Strapi **v3.6.11** → **v5**).
The v3 app stays live in production during the build; data is moved per-tenant
via a custom ETL (Phase 7). See the approved plan for the full phase breakdown.

## Status

| Phase | Description                                | Status         |
| ----- | ------------------------------------------ | -------------- |
| 0     | Pre-flight & environment setup             | 🟡 in progress |
| 1     | Schema conversion (76 CTs + 26 components) | ⬜ pending     |
| 2     | Core config & infrastructure port          | ⬜ pending     |
| 3     | Data-access layer rewrite                  | ⬜ pending     |
| 4     | Custom endpoints & controllers             | ⬜ pending     |
| 5     | Lifecycle hooks port                       | ⬜ pending     |
| 6     | Bootstrap & permissions port               | ⬜ pending     |
| 7     | Data migration ETL                         | ⬜ pending     |
| 8     | External integrations verification         | ⬜ pending     |
| 9     | Frontend rewrite (Vue)                     | ⬜ pending     |
| 10    | Pilot tenant cutover                       | ⬜ pending     |
| 11    | Rollout to remaining tenants               | ⬜ pending     |
| 12    | Docs & handoff                             | ⬜ pending     |

## Getting started

```bash
nvm use 20              # Node >= 20 required (v5)
cp .env.example .env    # fill in real values
npm run develop         # http://localhost:1337/admin
npm test                # Jest
npm run lint
npm run format
```

## Dev database

The dev MySQL DB is `projectes_v5_dev` on the shared `127.0.0.1` MySQL server
(same host as v3, separate database). Pool caps are env-driven (`DATABASE_POOL_*`)
to respect the shared server's `max_connections` under PM2.

## Secrets — keys to rotate (Risk R10)

The v3 repo's committed `.env` exposed live production secrets. **Before this v5
repo touches any production system, rotate every leaked key** — the values are
assumed compromised:

- `SENDGRID_API_KEY` (SendGrid)
- `SMTP_USER` / `SMTP_PASS` (Nodemailer/SMTP)
- MySQL `admin` user password (`DATABASE_PASSWORD`)
- Docker Hub PAT (was in a comment in v3 `.env`)
- `ZAI_API_KEY` (Zhipu GLM invoice parser)
- All Strapi salts/secrets (`APP_KEYS`, `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`,
  `JWT_SECRET`, `TRANSFER_TOKEN_SALT`, `ENCRYPTION_KEY`) — regenerate fresh.

This v5 repo only ever ships `.env.example` with placeholders.
