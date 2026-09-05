# HANDOFF — Strapi v3 → v5 migration: remaining work

Purpose: bootstrap a **new AI agent session** (another IDE) to continue this
migration. Read this file first, then `MIGRATION-NOTES.md` if present.

Last updated: 2026-09-05 (after Phase 8 complete + diligencia test environment
verified by manual testing).

---

## 1. Repos and roles

| Repo | Path | Role |
|---|---|---|
| v3 (production, LIVE) | `/home/jordi/Documents/work/webcoop/projectes/projectes` | Strapi 3.6.11, ~16 PM2 instances, one MySQL DB per tenant. **Do not break.** Reference for behavior parity. |
| v5 (rebuild) | `/home/jordi/Documents/work/webcoop/projectes/projectes-v5` | Strapi 5.51.1, JS (no TS), clean-room rebuild. **All new work goes here.** |
| Vue frontend | `/home/jordi/Documents/work/webcoop/projectes/projectes-front` | Vue 2 + buefy, 189 `.vue` files, calls the API through `src/service/index.js`. **Untouched so far — P9 starts here.** |

Node 20 is required (`.nvmrc` present; npm scripts fail fast with a clear
message on older Node — node-ical 0.26 crashes on Node 18).

## 2. What is DONE (verified, committed)

- **P0–P2** Scaffold, 75 content types + 26 components converted (350+ tables),
  config/cron/email ported. v5 boots clean.
- **P3** `src/services/query-adapter.js` (`adaptQuery` — v3 params → v5 filters/
  sort/pagination) + `src/services/raw-sql.js` (forced parameter binding; fixes
  the v3 SQL-injection in emitted-invoice.payEntity).
- **P4** All 61 custom endpoints; `src/api/project/services/totalsRefreshScheduler.js`
  redesigned PM2-safe (projects.dirty flag drained by a */2 cron).
- **P5** 26 lifecycles incl. the big four: emitted-invoice (ESBORRANY→SERIE-000N
  state machine), project, order (1,839 LOC), verifactu-chain (AEAT hash chain).
- **P6** Bootstrap seeds permission matrix via official
  `users-permissions.role.updateRole` (1 public + 311 authenticated actions)
  plus seed rows (verifactu settings, declarations, default bank account).
- **P7** ETL `tools/etl/migrate.js` + `tools/etl/validate.js`: raw SQL
  INSERT…SELECT v3→v5, idempotent (TRUNCATE+insert), numeric ids preserved.
  Migrated & validated: **arada** (→ `projectes_v5_dev`) and **diligencia**
  (→ `projectes_v5_diligencia`, 77 tables / 34,449 rows / 75/75 tables match).
- **P8** FACe fully ported (service + XAdES signer `utils/sign-facturae.js`,
  verify-setup/check-status controllers, both crons), SendGrid local provider
  (`src/providers/email-sendgrid`), integration audit fixes (v3 leftovers in
  verifactu/project/gantt/order code paths).
- **P9-prep (backend)** `adaptCtxQuery` v3→v5 translation wired into ALL core
  `find` overrides — the frontend can keep sending v3 query strings
  (`_limit`, `_sort`, `_q`, `_where`, flat field filters). Verified live.
- **Test env for diligencia** DB + 5 admin users ported (bcrypt hashes kept —
  old v3 admin passwords work, all Super Admin) + 72M uploads copied +
  `.env` points at `projectes_v5_diligencia`. Manual API tests passing.

Verification commands: `npm test` (70 unit tests), `npx eslint src/ config/`
(0 errors), `npm run dev` boots, manual curl of `/api/projects`, `/api/contacts`,
`/api/emitted-invoices`, `/api/activities`, `/api/payrolls` with a JWT.

## 3. Remaining work (in order)

### P9 — Frontend rewrite (Vue) · the next task

Goal: `projectes-front` consumes the v5 API. **The backend already accepts the
frontend's v3-style query params** — only transport differences remain.

Single choke point: `projectes-front/src/service/index.js` (axios factory;
124 files import it, ~602 HTTP calls go through it — 441 get / 87 put / 51
post / 23 delete). Rewrite it as a compatibility layer:

1. **Path mapping** (request interceptor or URL mapper):
   - content routes get an `api/` prefix (`contacts/basic?...` → `api/contacts/basic?...`)
   - v3 auth paths: `users-permissions/auth/local` → `api/auth/local`,
     `users-permissions/auth/forgot-password` → `api/auth/forgot-password`,
     `users-permissions/auth/reset-password` → `api/auth/reset-password`
   - `users/me` → `api/users/me`; `upload` → `api/upload`
2. **Envelope unwrap** (response interceptor): v5 list/read endpoints return
   `{ data, meta }`. Replace `response.data` with the unwrapped array/object so
   views' `(await ...).data` keeps working; stash `meta` (e.g. `response.meta`)
   for pagination. Auth/user endpoints (login, users/me) return plain objects —
   only unwrap when BOTH `data` and `meta` exist.
3. **Timestamp aliases**: v5 returns `createdAt`/`updatedAt`/`publishedAt`;
   frontend reads `created_at` (36 uses) / `updated_at` (17 uses). Add snake_case
   aliases in the unwrap step. `users_permissions_user` attribute name was KEPT
   in v5 schemas — no rename needed (285 uses).
4. **Error shape**: v5 error body is `{ error: { message } }`; add top-level
   `message` alias for views reading v3-style errors.

Then: log in via `POST /api/auth/local` (migrated users keep passwords), smoke
every screen (Orders, Projects, Treasury, Invoices, Dedicació, Stats…), fix
per-view issues. Test with the diligencia dataset on v5 and the same tenant on
v3 side by side (v3 on 1337, v5 with `PORT=1338 npm run dev`).

Known frontend call style (keep working): `service({ requiresAuth: true }).get(
"contacts/basic?_limit=-1&_sort=name:ASC&_q=...")` — params in the URL string;
backend translates them (committed `7c86275`).

### P10 — Pilot tenant cutover (needs user decisions)

Pick pilot tenant + maintenance window. Deploy v5 alongside v3 (separate PM2
app + DB + nginx route), parallel-run ≥1 business cycle (FACe, VeriFactu,
crons, payroll), delta-sync + switch nginx, keep v3 hot-rollback 1 week.
**R5: never run v3 AND v5 VeriFactu for the same taxpayer simultaneously.**

Per-tenant provisioning runbook (repeatable, ~10 min, proven twice):

```bash
# 1. create DB
mysql -e "CREATE DATABASE projectes_v5_<tenant> CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
# 2. boot once to generate schema + permission seeds, then kill
cd projectes-v5 && DATABASE_NAME=projectes_v5_<tenant> npm run start
# 3. migrate + validate (needs env: set -a; source .env; set +a)
node tools/etl/migrate.js  --from <tenant> --to projectes_v5_<tenant>
node tools/etl/validate.js --from <tenant> --to projectes_v5_<tenant>
```

Admin users port (bcrypt hashes are compatible v3→v5; role 1 = Super Admin):

```sql
INSERT INTO projectes_v5_<t>.admin_users
  (document_id, firstname, lastname, username, email, password, is_active, blocked, prefered_language, created_at, updated_at)
SELECT UUID(), firstname, lastname, username, email, password, isActive, IFNULL(blocked,0), preferedLanguage, NOW(), NOW()
FROM <t>.strapi_administrator;
INSERT INTO projectes_v5_<t>.admin_users_roles_lnk (user_id, role_id, user_ord, role_ord)
SELECT id, 1, 1, 1 FROM projectes_v5_<t>.admin_users;
```

Then `rsync` the tenant's production `public/uploads` into v5's `public/uploads`
(filenames preserved; DB references line up), set `.env` `DATABASE_NAME`, boot,
smoke test.

### P11 — Rollout to remaining tenants

Known tenant DBs (projectes schema — verify each has `projects`,
`orders`, `users-permissions_user` tables before migrating):

| tenant | projects | app users | orders | migrated? |
|---|---|---|---|---|
| diligencia | 26 | 64 | 20,992 | ✅ `projectes_v5_diligencia` |
| arada | 1 | 10 | 0 | ✅ `projectes_v5_dev` |
| raiels | 181 | 9 | 0 | – |
| arrandeterra | 129 | 13 | 0 | – |
| somprovisionals | 62 | 5 | 0 | – |
| emprius, nuriasocial, + others on the server | ? | ? | ? | inventory first |

Schedule 2–3 tenants/week; one-at-a-time rollback. Decommission v3 after the
final tenant + full backup.

### P12 — Docs & handoff

Update `docs/` for v5 UIDs; API-shape changelog (v3→v5 differences this repo
already absorbs: envelope, params, paths); v5 version of the provisioning
scripts (`scripts/templates/pm2-app.config.js.template`, Dockerfile,
`create-instance.sh` runbook).

## 4. v5 conventions & gotchas (learned the hard way)

- **Node 20** (`nvm use` picks up `.nvmrc`). Port 1337 conflicts from stale
  processes: `pkill -f "stra[p]i"` (bracket avoids self-match).
- **Data access**: `strapi.db.query(uid)` = raw repo, `{where, populate, orderBy,
  limit}` args, NO lifecycles (use for internal writes — the v3 `_internal` flag
  is obsolete). `strapi.documents(uid)` = Document Service (D&P + media
  populate — use for reading media fields like certificates/logos).
  `strapi.query(uid)` still exists (deprecated) but REQUIRES full UIDs.
- **v3 populate ≠ v5**: v3 `query().find()` populated relations one level by
  default; v5 `db.query` populates NOTHING unless asked. Any ported code reading
  `row.relation.attr` needs `populate: { relation: true }` (or deeper objects).
- Components ARE returned by db.query without populate; media (upload) fields
  are NOT — use documents API.
- Timestamps on v5 rows: `createdAt`/`updatedAt`/`publishedAt` (camelCase).
- **Services**: a CT's `services/<ct>.js` MUST use `createCoreService` — a plain
  object export registers fine but silently lacks core CRUD methods → 500
  "strapi.service(...).find is not a function" (fixed for project in `05e64dd`;
  `services/projectCache.js` holds the non-service helpers).
- **createCoreService returns a FACTORY** — never `require()` a service module
  directly and destructure; go through `strapi.service(uid)` or split plain
  helpers into their own file.
- REST sort validation: sort must be array of `'field:dir'` STRINGS (object form
  is rejected). Handled inside `adaptCtxQuery`.
- Lifecycles: only hook exports allowed; `afterFind`/`afterFindOne` removed in
  v5 → do it in controller find/findOne overrides (see order/project/month).
- ETL quirks: skip `upload_file_morph` rows with `related_id <= 0` (corrupt
  v3 orphans overflow v5 INT UNSIGNED); ETL needs env vars exported
  (`set -a; source .env; set +a`).
- Admin API tokens (for curl testing): table `strapi_api_tokens`,
  `kind='content-api'`, `type='read-only'`, `access_key` = HMAC-SHA512 of the
  raw token salted with `API_TOKEN_SALT` from `.env`. Note: routes with
  user-policies (e.g. orders) 403 for API tokens — test those with a real
  users-permissions JWT (`POST /api/auth/local`).
- FACe/VeriFactu need per-tenant config (me.face + certificate in settings) —
  dry-run via `FACE_DRY_RUN=true`.

## 5. Key files map (v5 repo)

```
src/services/query-adapter.js        adaptQuery + adaptCtxQuery (v3 param compat)
src/services/raw-sql.js              rawExecute (parameter-bound raw SQL)
src/services/bootstrap-permissions.js permission matrix + seed rows (runs on boot)
src/api/…/lifecycles.js              26 lifecycle files (big four: emitted-invoice,
                                      project, order, verifactu-chain)
src/api/face-queue/                  FACe service + utils/sign-facturae.js
src/providers/email-sendgrid/        local SendGrid provider
config/cron.js                       4 jobs: task.email 3am, totals */2,
                                      face check */30, face retry */5
tools/etl/migrate.js | validate.js   per-tenant ETL + validation
scripts/templates/pm2-app.config.js.template  PM2 config per tenant
docs/                                existing v3-era docs (update in P12)
```

## 6. Open decisions for the user

1. Pilot tenant for P10 + maintenance window.
2. Where production instances/uploads live (rsync source per tenant).
3. Whether frontend P9 is done agent-side in `projectes-front` (repo is local
   and accessible) — recommended yes.
4. Rotate the secrets that were historically committed in the v3 `.env`
   (SendGrid/SMTP/MySQL/PAT/Z.ai) before any public v5 deploy.
