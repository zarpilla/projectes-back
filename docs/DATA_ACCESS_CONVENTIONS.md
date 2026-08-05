# Data-access conventions (v5)

This document defines how the migrated code talks to the database in Strapi v5,
replacing every v3 `strapi.query()` / Bookshelf / raw-SQL pattern. **Every**
controller, service, lifecycle, and cron job must follow these rules.

## The three access layers (use in this order of preference)

### 1. Document Service — default for all CRUD

```js
// findMany
const { results, pagination } = await strapi.documents('api::project.project').findMany({
  filters,
  populate,
  sort,
  fields,
  status,
  locale,
});
// findOne / create / update / delete / publish / unpublish exist too.
```

Use for: anything that should respect Draft & Publish, locales, lifecycles, and
Content-API sanitization. **This replaces `strapi.query(m).find/.findOne/.create/...`.**

v5 list endpoints return `{ data: [...], meta: { pagination } }` — the controller
helper `sanitizeOutput`/`transformResponse` handles wrapping; in custom controllers
return the result and Strapi wraps it, or build `{ data, meta }` explicitly.

### 2. `strapi.db.query` — bulk / no-D&P / raw filters

```js
await strapi.db.query('api::project.project').findMany({ where, populate, limit, offset, orderBy });
await strapi.db.query('api::project.project').update({ where: { id }, data });
await strapi.db.query('api::project.project').deleteMany({ where });
```

Use for: bulk operations, deletes that must NOT trigger D&P publishing semantics,
or where you need `where`-style filters without the Document Service wrapper.
**Still runs lifecycles.**

### 3. `strapi.db.connection` (Knex) — last resort: lifecycle bypass / raw SQL

**IMPORTANT: all raw SQL must go through the `src/services/raw-sql.js` helper**,
which enforces parameter binding and closes the v3 SQL-injection hole (R11).
Never call `strapi.db.connection.raw()` directly with string interpolation.

```js
const { rawExecute, bulkUpdate } = require('../../services/raw-sql');
// Parameter-bound raw SQL (NEVER string-interpolate)
await rawExecute(strapi, 'UPDATE orders SET emitted_invoice = ?, status = ? WHERE id IN (?)', [
  invoiceId,
  'invoiced',
  orderId,
]);
// Knex query builder bulk update (skips lifecycles — stored-totals refresh)
await bulkUpdate(strapi, 'projects', { id }, { dirty: false });
```

Use ONLY when you must bypass lifecycles (bulk invoice/order status updates,
stored-totals back-fill). **Always parameter-bind** — see P3.4 (the v3
`payEntity` string-interpolation SQL injection is fixed in the migration).

---

## Pattern translation table (v3 → v5)

| v3                                                                     | v5                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strapi.query('project').find(q)`                                      | `strapi.documents('api::project.project').findMany({ filters, populate, sort, pagination })`                                                                                                  |
| `strapi.query('project').findOne({ id })`                              | `strapi.documents('api::project.project').findOne({ documentId })`                                                                                                                            |
| `strapi.query('project').create(data)`                                 | `strapi.documents('api::project.project').create({ data })`                                                                                                                                   |
| `strapi.query('project').update({ id }, data)`                         | `strapi.documents('api::project.project').update({ documentId, data })`                                                                                                                       |
| `strapi.query('project').search(q)` (the `_q` path)                    | `strapi.documents('api::project.project').findMany({ filters: { $or: [...] }, ... })` or full-text via `filters: { $contains: ... }`. The v3 `.search`/`.find` split collapses into one call. |
| `strapi.query('user', 'users-permissions')`                            | `strapi.documents('plugin::users-permissions.user')`                                                                                                                                          |
| `strapi.query('project').model.fetchAll({ withRelated })`              | `strapi.documents('api::project.project').findMany({ populate: withRelated, limit: -1 })`                                                                                                     |
| `strapi.query('project').model.query(qb => qb.select(...).where(...))` | `strapi.db.connection('projects').select(...).where(...)` (knex) **or** Document Service `findMany({ filters, fields })`                                                                      |
| `strapi.connections.default.raw(sql)`                                  | `strapi.db.connection.raw(sql, [bindings])` — **always bind**                                                                                                                                 |
| `strapi.connections.default('projects').where().update()`              | `strapi.db.connection('projects').where().update()`                                                                                                                                           |
| `strapi.services['orders'].find(...)`                                  | `strapi.service('api::orders.orders').find(...)`                                                                                                                                              |
| `strapi.plugins['email'].services.email.send(...)`                     | `strapi.plugin('email').service('email').send(...)`                                                                                                                                           |
| `strapi.controllers.project.calculateProject(...)`                     | extract to a shared **service** function; call `strapi.service('api::project.project').calculate(...)`                                                                                        |
| `sanitizeEntity(e, { model: strapi.models.x })`                        | **delete it** — v5 sanitizes automatically via Document Service / Content-API                                                                                                                 |
| `parseMultipartData` (strapi-utils)                                    | **delete** (was a dead import in v3); use `strapi.controller(ctx).parseBody()` if ever needed                                                                                                 |
| `ctx.send(data)`                                                       | `return data;` (Strapi wraps it)                                                                                                                                                              |

---

## Filter operator translation (v3 → v5)

The v3 app passes operators as flat query params (`field_null`, `field_gt`,
`created_at_gte`, ...) or nested under `_where`. The `query-adapter.js` module
(see P3.2) normalizes both into v5 `filters` objects.

| v3 flat / `_where`                                  | v5 `$operator`                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `field_eq` or bare `field`                          | `{ field: value }` or `{ field: { $eq: value } }`                                    |
| `field_ne`                                          | `{ field: { $ne: value } }`                                                          |
| `field_lt` / `field_lte` / `field_gt` / `field_gte` | `$lt` / `$lte` / `$gt` / `$gte`                                                      |
| `field_in` (comma-string or array)                  | `{ field: { $in: [...] } }`                                                          |
| `field_nin`                                         | `{ field: { $notIn: [...] } }`                                                       |
| `field_null: true`                                  | `{ field: { $null: true } }`                                                         |
| `field_null: false`                                 | `{ field: { $notNull: true } }`                                                      |
| `field_contains`                                    | `{ field: { $contains: value } }`                                                    |
| `_where._or: [ {...}, {...} ]`                      | `{ $or: [ {...}, {...} ] }`                                                          |
| `_where._and: [...]`                                | `{ $and: [...] }`                                                                    |
| `published_at_null: false`                          | prefer `status: 'published'` on the call; else `{ publishedAt: { $notNull: true } }` |

### `_limit` / `_start` / `_sort`

| v3                        | v5                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `_limit: -1` (return-all) | `pagination: { limit: -1 }` (works because `maxLimit` is raised in `config/api.js` during migration) |
| `_limit: N`               | `pagination: { limit: N }`                                                                           |
| `_start: N`               | `pagination: { start: N }` (offset)                                                                  |
| `_sort: 'field:DESC'`     | `sort: [{ field: 'desc' }]`                                                                          |

### Populate

| v3 (2nd positional arg)                                                   | v5                                                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `[ 'leader', 'project_state', 'project_phases.incomes.estimated_hours' ]` | `{ populate: [ 'leader', 'project_state', 'project_phases.incomes.estimated_hours' ] }` |
| `[]` (load nothing)                                                       | `{ populate: [] }` (NOT `*`)                                                            |

---

## Draft & Publish

- v3 `draftAndPublish: true` CTs: `project`, plus 4 others.
- v3 in-controller `published_at_null = false` → v5 `status: 'published'` filter on
  Document Service calls, or `filters: { publishedAt: { $notNull: true } }` on
  `db.query`.
- Document Service `create`/`update` accept `status: 'published' | 'draft'`.

## IDs vs documentIds (v5 breaking change)

v5 introduces **documentId** (UUID) alongside numeric `id`. The Content-API and
Document Service key off `documentId`. For the **ETL** (Phase 7) we preserve the v3
numeric `id` in the `id` column and let v5 generate `documentId`s. Controllers that
read `ctx.params.id` may need to look up by `documentId`; the ETL/adapter handles
the mapping. (Detailed in Phase 7.)

## Lifecycle bypass

Two v3 mechanisms must be preserved:

1. Raw/knex SQL (Section 3 above) — used by invoice/order bulk status updates and
   stored-totals refresh. **Keep as knex in v5** (`strapi.db.connection`).
2. The `_internal` flag on emitted-invoice — v5 has no `_internal`; replace with
   a direct `strapi.db.query(...).update(...)` (skips D&P) or a service-level guard.
