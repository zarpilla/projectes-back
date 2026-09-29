# projectes-v5 — Strapi v3 → v5 migration

Clean-room rebuild of the `projectes` backend (Strapi **v3.6.11** → **v5**).
The v3 app stays live in production during the build; data is moved per-tenant
via a custom ETL (Phase 7). See the approved plan for the full phase breakdown.

## Status

**The migration is complete.** All 17 tenants were cut over to Strapi v5 on
2026-09-26; 16 are live and `milvietnams` was retired at the owner's request
(pm2 apps deleted, configs renamed `.disabled`, databases and files kept).

| Phase | Description                                | Status |
| ----- | ------------------------------------------ | ------ |
| 0–9   | Build, ETL, integrations, frontend         | done   |
| 10    | Pilot tenant cutover (buida, demo, webcoop)| done   |
| 11    | Rollout to remaining tenants               | done   |
| 12    | Docs & handoff                             | done   |

Post-cutover fixes ran through 2026-09-29. What was found, and why, is in
[`docs/V3_TO_V5_TRAPS.md`](docs/V3_TO_V5_TRAPS.md) — read that before debugging
anything that looks like missing data.

### Where to look

| Question | Doc |
| -------- | --- |
| A screen is blank / a value is missing | [`docs/V3_TO_V5_TRAPS.md`](docs/V3_TO_V5_TRAPS.md) |
| How do I write a query / which access layer? | [`docs/DATA_ACCESS_CONVENTIONS.md`](docs/DATA_ACCESS_CONVENTIONS.md) |
| How do I ship to the tenants? | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) |
| How does the ETL work? | [`tools/etl/DESIGN.md`](tools/etl/DESIGN.md) |
| What was the build plan / v5 gotchas? | [`HANDOFF.md`](HANDOFF.md) |

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
