# ETL design — v3 → v5 data migration (P7.1)

## Goal

Move one tenant's data from a v3 database to a v5 database on the same MySQL
server, preserving **numeric ids** (frontend references and cross-references
depend on them), **timestamps**, **publish state**, and **all relations**.

```
node tools/etl/migrate.js --from arada --to projectes_v5_dev [--dry-run] [--only ct1,ct2]
```

## Storage-model mapping (discovered from live schemas)

| Concern | v3 | v5 | Rule |
|---|---|---|---|
| Core rows | `<table>` (id, cols, created_at/updated_at/published_at, created_by/updated_by) | `<table>` + `document_id` | INSERT...SELECT preserving id; generate `document_id = UUID()`; copy published_at/created_at/updated_at; **drop created_by/updated_by** (audit refs to v3 admin users; kept NULL) |
| Scalar columns | snake_case | snake_case (same names) | intersect v3∩v5 columns |
| Relation (manyToOne / oneToOne) | inline FK column `<table>.<attr>` | `<table>_<attr>_lnk (<table>_id, <target>_id)` | per relation attr: detect v3 FK column → INSERT into lnk |
| Relation (manyToMany) | join table `<table>_<attr>__<targetTable>_<attr2>` | `<table>_<attr>_lnk` | copy id pairs; v5 `*_ord` columns left NULL (v3 had no order) |
| Components data | `components_<group>_<name>` (identical) | same | straight copy incl. ids |
| Component links (entity) | `<table>_components (field, order, component_type, component_id, <table>_id)` | `<table>_cmps (entity_id, cmp_id, component_type, field, order)` | column rename only |
| Component links (nested) | `components_<g>_<n>_components` | `components_<g>_<n>_cmps` | same rename rule |
| Uploads | `upload_file` | `files` (+document_id, folder_path '/') | column renames: alternativeText→alternative_text; skip created_by |
| Upload links | `upload_file_morph` | `files_related_mph` | column renames |
| Users | `users-permissions_user` | same + document_id | copy incl. bcrypt password hashes; roles by TYPE (v3↔v5 both 1=authenticated 2=public) |
| Single-types | `us` (me), `configs`, `home_menus`, `verifactus` | same tables | normal copy |

## Execution strategy

1. **Schema-driven**: the CT registry is built from the v5 `schema.json` files
   (content-types + components) — no hardcoded table lists.
2. **Raw SQL `INSERT ... SELECT`** between databases (`v3db.table` →
   `v5db.table`): fast, transactional per table, no ORM overhead.
3. **`SET FOREIGN_KEY_CHECKS=0`** during the load (v5 declares 613 FK
   constraints; v3 had none). Order becomes irrelevant; constraints re-enabled
   + orphan-check in validation afterwards.
4. **Idempotent**: every table is TRUNCated (within FK-checks-off) before
   insert, so re-running yields identical state.
5. **Phase order** per run: core scalars → component data → component links →
   relation links → uploads → users → validation.

## Excluded / handled separately

- **v3 runOnce backfills (P6.2/P7.3)**: NOT re-run — v3 production data is
  already backfilled (the scripts executed in v3). The ETL copies corrected data.
- **strapi_* / admin_* tables**: not migrated (v5 bootstraps its own).
- **v3 `upload_file.formats` JSON**: copied verbatim (shape unchanged).

## Validation (P7.5)

Per content type:
1. Row count v3 == v5 (hard fail on mismatch).
2. Relation link counts per attribute.
3. Sample-row diff (first + random N rows): scalar columns equal.
4. Orphan check after FK re-enable.
5. Report written to `tools/etl/report-<from>-<ts>.json`.

## Tenant rollout (P10/P11)

The same command per tenant:
`node tools/etl/migrate.js --from <tenant_v3> --to <tenant_v5>`
Plus `public/uploads/` rsync (P7.4).
