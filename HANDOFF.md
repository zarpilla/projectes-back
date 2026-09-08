# HANDOFF — Strapi v3 → v5 migration: remaining work

Purpose: bootstrap a **new AI agent session** (another IDE) to continue this
migration. Read this file first, then `MIGRATION-NOTES.md` if present.

Last updated: 2026-09-05 (P9 API compatibility done and smoke-tested against
the diligencia dataset; per-screen browser testing is the next step).

---

## 1. Repos and roles

| Repo | Path | Role |
|---|---|---|
| v3 (production, LIVE) | `/home/jordi/Documents/work/webcoop/projectes/projectes` | Strapi 3.6.11, ~16 PM2 instances, one MySQL DB per tenant. **Do not break.** Reference for behavior parity. |
| v5 (rebuild) | `/home/jordi/Documents/work/webcoop/projectes/projectes-v5` | Strapi 5.51.1, JS (no TS), clean-room rebuild. **All new work goes here.** |
| Vue frontend | `/home/jordi/Documents/work/webcoop/projectes/projectes-front` | Vue 2 + buefy, 189 `.vue` files, calls the API through `src/service/index.js`. **P9 work is on branch `p9/strapi-v5-api-compat`.** |

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

### P9 — Frontend/API compatibility · DONE (API level), browser testing pending

`projectes-front` branch **`p9/strapi-v5-api-compat`** (commits `010c6d9`,
`1eddc62`); backend fixes on `main` (`f953aba`, `d490ecf`, `03f91a9`).

**Frontend** — `src/service/v5-compat.js` (new, pure) wired into the axios
interceptors in `src/service/index.js`. All 118 files / ~602 calls keep their v3
call style; the layer absorbs the six transport differences:

1. every route moves under `/api`
2. core create/update get the `{ data: … }` **request** envelope — custom
   actions (`contacts/unify`, `orders/pdf`, `<type>/upload`), `auth/*`,
   the users-permissions routes and `upload` deliberately stay flat
3. `{ data, meta }` **response** unwrap; pagination stashed on `response.meta`
4. `<type>/count` (removed in v5) emulated as a one-row read reporting
   `meta.pagination.total`
5. `created_at`/`updated_at`/`published_at` aliases for v5's camelCase
6. v3 `message`/`statusCode` aliases on error bodies (`views/Login.vue` updated —
   it read the nested users-permissions error form v5 no longer sends)

**Backend** — five defects found by smoke-testing, all fixed:

- **Public role had no auth permissions.** `updateRole()` *replaces* a role's
  permission set; the public matrix listed only `logos.find`, so every boot wiped
  the users-permissions defaults and `POST /api/auth/local` answered 403 — nobody
  could log in, on any tenant. Now seeds the same six the v3 public role had.
- **`user.role` was declared on the non-owning side** (`oneToOne`/`mappedBy`
  instead of the stock `manyToOne`/`inversedBy`), so no link table existed and
  `user.role` was always null → the auth strategy threw → **401 on every
  authenticated request**. The ETL had always been ready to fill the links but
  skipped silently when the table was missing; it now fails loudly.
- **All 60 custom routes were mounted at the wrong paths.** v5 does *not*
  namespace custom routes by content type (the comment in every route file
  claimed it did), so they landed at the root — seven APIs registered
  `/api/basic`, and treasury-validation's `/:entity_type/:entity_id/:sub_type?`
  became a catch-all that swallowed `/api/users/me`. Restored from v3.
- **Custom routes were shadowed by the core `/:id` route** (alphabetical file
  order) — hence the `01-custom-*.js` filenames.
- **`limit: -1`** (v3's "all rows") is a SQL syntax error in v5; removed from 62
  call sites and guarded by `dbLimit()` in the adapter.

Plus: 8 v3-signature `strapi.query('project')` calls ported (they 500'd the main
Projects screens), dotted relation filters (`_where[contact_types.id]`) now nest,
16 permissions the v3 authenticated role had restored, and v3's default
first-level populate reinstated via `src/middlewares/v3-compat.js` — which also
resolves the frontend's **numeric ids** to v5 documentIds (`ctx.state.v3.numericId`
keeps ported controllers working).

**Verification**: 85 backend unit tests, eslint clean, and
`node tools/v5-smoke.mjs` in the frontend repo (22 checks: auth flow, list
screens, pagination meta, emulated `/count` — 20,992 orders matching the DB —
timestamp aliases, populated relations, `users/me` role + permissions,
user-list paging, findOne by numeric id, and a create/update/delete
round-trip). Probing the 94 endpoints the frontend calls:
**90 pass**; the other 4 are the three `/count` paths (served client-side now)
and `projects/dedications` correctly rejecting a missing required param.

```bash
# side-by-side test setup used
cd projectes-v5 && PORT=1338 npx strapi start          # v5 on 1338, v3 stays on 1337
cd projectes-front && SMOKE_USER=<email> SMOKE_PASS=<pw> \
  API_URL=http://127.0.0.1:1338 node tools/v5-smoke.mjs
```

**Still to do**: run the app in a browser against 1338 and click through every
screen (Orders, Projects, Treasury, Invoices, Dedicació, Stats…). The API shapes
are verified but rendering, forms and the PDF/upload flows are not. Watch for:
the `populate=*` default is one level only — screens reading `a.b.c` need their
controller to populate explicitly; and `_q` full-text search is not reproduced
(v5 has no db-level equivalent), so search boxes need checking.

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
node tools/etl/nullcheck.js --from <tenant> --to projectes_v5_<tenant>
```

`nullcheck.js` joins v3/v5 rows by id per table and reports any column that
was populated in v3 but is NULL in v5 (pairs Strapi-renamed columns like
face_dir3_oc → face_dir_3_oc the same way the ETL does). Verified clean on
diligencia and arrandeterra (104 tables each, zero lost values).
`scripts/repair-v3-migration.js` (added by the P9 session) repairs
renamed-column/media-link defects in place for already-migrated tenants —
prefer re-running the ETL when possible.

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
- **Custom routes are NOT namespaced by content type.** A route file's `path` is
  mounted verbatim under `/api`, so it must carry its own plural prefix
  (`/contacts/basic`, not `/basic`). Route files also load in alphabetical order
  and the core router's `/<plural>/:id` shadows later static paths — hence
  `01-custom-<api>.js`.
- **`limit: -1` is invalid** for `strapi.db.query` (knex emits `LIMIT -1`).
  Omit the limit to mean "all"; use `dbLimit(adaptQuery(...))`.
- **Permissions are seeded with `updateRole()`, which REPLACES** the role's set —
  anything omitted from the matrix in `bootstrap-permissions.js` is revoked on
  every boot, including the plugin defaults.
- **Numeric ids**: `/api/<plural>/:id` resolves `:id` as a documentId. The
  `v3-compat` middleware rewrites numeric ids; controllers that need the numeric
  value must read `numericId(ctx)`, not `ctx.params.id`.
- **Draft & Publish is OFF everywhere, deliberately.** v5's version keeps a
  draft AND a published row per document and renumbers the published one on
  every save, which breaks the numeric ids the whole migration preserves (the
  frontend addresses everything by them). The five types that used it — project,
  product, logo, document-type, income-type — carry a `trashed` boolean instead,
  since only the null-ness of v3's `published_at` was ever read. `published_at`
  itself cannot be reused: with D&P off Strapi still owns that column and stamps
  it on every write. `published_at_null` in a query and `{ published_at: null }`
  in a body are translated onto `trashed` by the adapter and the middleware, so
  the frontend is unchanged.
- **Relations need exactly ONE owning side**: the owner declares `inversedBy`
  (and gets the `<table>_<attr>_lnk` join table), the other `mappedBy`. Nothing
  warns when this is wrong — the table is never created, the ETL silently skips
  it, and every populate returns null. `tests/schema-relations.test.js` guards
  this; if it ever fails, fix the schema, boot once to create the table, then
  re-run the ETL for every already-migrated tenant.
- **`me` needs populate.** Its settings live in components (`options`, `quotes`,
  `orders_options`) and media/relations, and the Document Service returns none
  of it by default. Always go through `services/me-settings.js#getMe()`.
- **Plugin routes bypass both compat paths.** `/api/users*` never reaches
  `adaptCtxQuery`, addresses rows by NUMERIC id (so no documentId rewrite), and
  hands its query to `query-params.transform`, which reads
  `filters`/`sort`/`populate`/`start`/`limit` at the TOP level — not the nested
  `pagination` object. `v3-compat` handles them separately, populating
  `['role','permissions']` (the frontend authorization model is
  `me.permissions.map(p => p.permission)`).
- Admin API tokens (for curl testing): table `strapi_api_tokens`,
  `kind='content-api'`, `type='read-only'`, `access_key` = HMAC-SHA512 of the
  raw token salted with `API_TOKEN_SALT` from `.env`. Note: routes with
  user-policies (e.g. orders) 403 for API tokens — test those with a real
  users-permissions JWT (`POST /api/auth/local`).
- FACe/VeriFactu need per-tenant config (me.face + certificate in settings) —
  dry-run via `FACE_DRY_RUN=true`.

## 5. Key files map (v5 repo)

```
src/middlewares/v3-compat.js         numeric id -> documentId, v3 default populate
src/services/query-adapter.js        adaptQuery + adaptCtxQuery (v3 param compat),
                                      dbLimit / expandPopulate / v3FindArgs
src/services/me-settings.js          getMe() — the `me` single type, populated
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
3. Whether to merge `p9/strapi-v5-api-compat` before the browser pass, or keep
   iterating on the branch.
4. Rotate the secrets that were historically committed in the v3 `.env`
   (SendGrid/SMTP/MySQL/PAT/Z.ai) before any public v5 deploy.
