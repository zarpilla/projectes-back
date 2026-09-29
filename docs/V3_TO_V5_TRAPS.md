# v3 → v5 traps: symptom → cause → fix

A catalogue of the failure modes found while running the migrated app in
production. Every entry happened; each names the symptom first, because the
symptom is what you will have when you come back to this.

See also `DATA_ACCESS_CONVENTIONS.md` (the rules) and `DEPLOYMENT.md` (shipping).

---

## 0. The one that explains most of them

**v3 handed back relations for free; v5 hands back nothing you did not ask for.**

Bookshelf exposed a relation as an FK column, so `order.route` was the id and
`contact.sector` was populated by default. v5's `db.query` omits an unpopulated
relation **entirely** — the key is not `null`, it is absent. Ported code that
reads `row.relation.attr` therefore reads `undefined`, and `undefined` rarely
throws: it silently takes the wrong branch, renders an empty list, or filters
everything out.

Seven of the nine bugs fixed on 2026-09-28 were this. **When a screen is blank
but the data looks fine in the database, suspect populate before suspecting the
ETL.**

---

## 1. Unpopulated relation → empty column / empty list

| | |
| --- | --- |
| **Symptom** | Sector column shows `-` on every contact; "Sòcies" empty; attachment lists empty |
| **Cause** | Custom "lightweight" endpoint passing `populate: { projects: false }` — which populates **nothing** |
| **Fix** | Populate what the caller dereferences; keep the heavy collections off |

Scalars still render, which is why these look *selectively* broken. In
`ContactsTable`, `Població` is a plain column and kept working while `Sector` and
`Sòcies` (both relations) went blank — that pattern is the tell.

Every `/basic`-style endpoint has needed this repair: `/contacts/basic`,
`/projects/basic`, `/orders/table`. If a fourth exists, assume it has the same gap.

Related: `finalPrice` is computed in a v3 `afterFind` hook, which v5 removed. The
port added it to `find`/`findOne` but not to `/orders/table`, the endpoint the
list actually calls — so the Preu column showed `?` for every row.

## 2. `select:` inside a populate silently drops fields — **the expensive one**

| | |
| --- | --- |
| **Symptom** | "Ruta" picker empty; pickup city unresolved; "Punt de recollida en finca" buttons blank |
| **Cause** | Narrowing a populated relation with `select: [...]` and omitting a field the UI reads |
| **Fix** | Populate the relation **whole** unless you have enumerated every field read |

Three separate regressions in one afternoon, all mine, all the same shape:

```
route: { select: ['id','name'] }              → cr.route.active undefined → filter rejected every row
collection_points: { select: ['id'] }         → cp.city undefined → pickup city unresolved
collection_points: { select: ['id','city'] }  → cp.name undefined → buttons rendered blank
```

Checking which *relations* a caller reads is **not enough**. It is the fields
inside them that matter, and a `select` drops the rest without a word. These feed
UI lists, where a missing field is an empty screen rather than an error.

The payload saving was never worth it — the socies response is 0.056 MB either
way. Trim rows and whole entities, not fields, unless you can exercise the screen.

## 3. v3 query spellings reaching `db.query`

| | |
| --- | --- |
| **Symptom** | `Unknown column 't0.status_nin' in 'where clause'` → 500 |
| **Cause** | `{ status_nin: [...], _sort: 'id:ASC' }` passed as `where`; v5 treats unknown keys as column names |
| **Fix** | `status: { $notIn: [...] }`, and sorting via `orderBy` |

Six live sites, plus `published_at_null` / `_limit` / `_sort` built into an object
and handed straight to `db.query`. Route those through `adaptQuery` + `toDbArgs`,
which also knows v3's `published_at_null` maps onto v5's `trashed`, not
`publishedAt`.

Guarded by `tests/v3-query-leftovers.test.js`, which scans for the whole class.
It found five sites nobody was looking for.

## 4. `create()` / `update()` signatures

| | |
| --- | --- |
| **Symptom** | `TypeError: Cannot read properties of undefined (reading 'route_date')` inside the model's own `beforeCreate` |
| **Cause** | `db.query(uid).create(values)` — the v3 signature. v5 needs `create({ data: values })` |
| **Fix** | Always `{ data }` for create, `{ where, data }` for update |

A bare `create` leaves `event.params.data` undefined, so the model's own
lifecycle throws. Where the call sits inside a `try/catch` that only logs (order
tracking did), it fails **silently** instead — no error, just no rows.

## 5. Media fields: `multiple`, not `relation`

| | |
| --- | --- |
| **Symptom** | Uploads attach correctly but no attachment list ever renders |
| **Cause** | Schemas ported with `"relation": "oneToMany"`; v5 reads only `multiple` |
| **Fix** | `"multiple": true` on every list-valued media attribute |

```js
// @strapi/core/dist/utils/transform-content-types-to-models.js
case 'media':
  relation: attribute.multiple === true ? 'morphMany' : 'morphOne',
```

All 17 media fields lacked `multiple`, so the 10 list fields resolved as
`morphOne` — a single object where the frontend does
`v-if="form.documents && form.documents.length"`. The 7 genuinely single fields
(logo, certificates, pdf) were `morphOne` by accident and worked, which is why
only lists looked broken. No data change: both live in `files_related_mph`.

Guarded by `tests/media-multiple.test.js`.

## 6. A new custom route 403s until it is granted

| | |
| --- | --- |
| **Symptom** | New endpoint returns 403 for authenticated users |
| **Cause** | Not listed in the matrix in `bootstrap-permissions.js` |
| **Fix** | Add the action; the bootstrap creates the permission row on next boot |

`POST /api/upload` returned 403 because v3's grant was made through the admin UI
and never written into the seed the v5 matrix was ported from.

`updateRole()` **replaces** the role's permission set on every boot, so a row
added by hand to the database is wiped on the next restart. The matrix is the
only source of truth.

## 7. Login 500 behind nginx

| | |
| --- | --- |
| **Symptom** | `POST /api/auth/local` → 500 for valid credentials, 400 for bad ones |
| **Cause** | Koa did not trust `X-Forwarded-Proto`, so the `secure` refresh cookie threw |
| **Fix** | `proxy: { koa: env.bool('IS_PROXIED', false) }` in `config/server.js`; `IS_PROXIED=true` per tenant |

The cookie is only marked `secure` when `NODE_ENV=production`, which is why local
dev never saw it. The 400-for-bad-credentials/500-for-good-credentials split is
the tell: the failure is *after* the password check.

Related: with `withCredentials: true`, browsers treat
`Access-Control-Allow-Headers: *` **literally**, so CORS must list headers
explicitly.

## 8. ETL: v3 sentinel `0` became a link to a row that does not exist

| | |
| --- | --- |
| **Symptom** | Relation populates as `null` although a link row exists |
| **Cause** | v3 wrote `0` into an FK to mean "unset"; the link build filtered only `IS NOT NULL` |
| **Fix** | Filter `> 0` (in SQL `NULL > 0` is NULL, so this still excludes NULL) |

diligencia had 830 `contacts_legal_form_lnk` rows pointing at `legal_form_id = 0`
(`legal_forms` has ids 1 and 2). ~3,530 more remain across 10 other tables, and
the other 15 tenants are unsurveyed. They are inert — they populate as `null` —
but they make the data claim a relation it does not have.

Also from the ETL: v3's morph table had no ordering column, so every migrated
`files_related_mph` row landed with `order = NULL`. MySQL sorts NULLs **first**,
so a migrated link outranked a newer upload — on a single-file field that means
the stale file wins. Backfilled; number NULLs *after* any existing order.

## 9. Frontend: `typeof null === "object"`

| | |
| --- | --- |
| **Symptom** | `can't access property "id", cr.route is null` |
| **Cause** | `typeof cr.route === 'object' ? cr.route.id : cr.route` takes the object branch for `null` |
| **Fix** | Guard explicitly, or skip rows whose relation is missing |

536 of diligencia's 902 city-routes point at a deleted route (the same rows
dangle in v3), so this is guaranteed to fire. Hit twice — `CityRoute.vue` and
`OrdersTable.vue`. `ProjectPhases.vue` and `ContactsForm.vue` still carry the
pattern; no dangling data behind them today.

## 10. Performance: sanitisation dominates, not the query

| | |
| --- | --- |
| **Symptom** | A list endpoint takes 3–9s for ~1000 rows |
| **Cause** | Core route gets `populate: '*'` from the v3-compat middleware, then `contentAPI.sanitize.output` walks every field of every row |
| **Fix** | A custom route returning `db.query` rows — no sanitise pass — selecting only what the caller reads |

Measured on 1175 contacts (dev machine; the VPS runs 16 Strapi instances on
shared CPU, so production is several times worse):

```
db query (populate '*')     126 ms
sanitize.output             942 ms   ← ~90%
payload                    2.02 MB
```

**Populating fewer relations barely helped** (942 → 732 ms) — the cost scales
with rows × fields. The lever is not shipping the whole entity:

```
contacts?_limit=-1     1068 ms  2.02 MB   →  contacts/for-orders   36 ms  0.59 MB
city-routes?_limit=-1   159 ms  0.479 MB  →  city-routes/basic     18 ms  0.210 MB
```

Do **not** make `/api/contacts` skip sanitisation to match: that endpoint is
generic and sanitisation is what enforces field-level permissions there.

Two other wins on the same page: nine independent lookups were `await`ed one
after another (now `Promise.all`), and the owner `<b-select>` has
`@input="changeOwner"` — Buefy emits `input` for a **programmatic** v-model write
too, so initialising a new order fetched the client list twice.

---

## 11. Method notes

- **Fixing one layer exposes the next.** uploads 403 → 500; collection-order SQL
  error → `beforeCreate` crash; sector check → transfer-check null deref. When a
  whole feature was dormant, expect a chain, and do not read the next error as a
  new regression.
- **Check the data before believing a data-loss report.** Sector, prices, file
  links, activity types, contact-user links — every one was intact; the bug was
  always in the read path. Conversely, confirm the *underlying* value before
  declaring a fix: a `NULL` price and a missing `finalPrice` look identical.
- **Guard tests that scan for a class find bugs you were not looking for.**
  `v3-query-leftovers` found five extra sites; `select-scalars-only` caught a
  false positive worth fixing in the test itself. Always verify a new guard
  *fails* when you reintroduce the bug.
- **Error messages can name the wrong field.** *"no te sector"* tests
  `legal_form`. Read the code, not the string.

## 12. Guard tests

| Test | Catches |
| ---- | ------- |
| `v3-query-leftovers` | v3 flat operators / `_sort` as query keys; bare `create()` |
| `select-scalars-only` | relation names inside a `select` (per-entity aware) |
| `media-multiple` | media attributes missing `multiple` |
| `contact-basic-populate`, `project-basic-populate` | schema-driven: a new single-valued relation must be populated |
| `contact-for-orders`, `city-route-basic` | lean endpoint shapes, and that they are granted |
| `collection-order-grouping` | the reuse predicate and its populate |
| `order-final-price` | the discount arithmetic and which handlers apply it |
| `etl-sentinel-fk` | link builds filtering `> 0` |
| `proxy-cookie`, `env-file-quoting`, `etl-collation`, `nullcheck-pairing`, `upload-permission`, `upload-ref-compat` | one incident each |

`npm test` runs them all (382 at time of writing). Node 20 is required — the
suite needs `--experimental-vm-modules`, which `npm test` sets; a bare
`npx jest` will fail on the MIME-detection tests.
