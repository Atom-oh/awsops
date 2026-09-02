# S3 bucket map + IAM S3-access drill-down — 2 gap-audit items (L241, L242)

**Status:** Batch 35, 2026-09-02 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch35`.
**WA pillar:** Security (bucket exposure at a glance / access-path visibility).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L241 (TreeMap 'Bucket Map by
Region'), L242 (detail-panel 'IAM Roles with S3 Access').

## Decisions
- **L241** — new `S3BucketMap` component on the s3 page's embed slot: buckets render as
  blocks grouped by region, colored by security status with v1's palette and PRECEDENCE —
  **Public** (red, `bucket_policy_is_public === true`) > **Versioned** (green,
  `versioning_enabled === true`) > **Standard** (cyan) — plus an **Unknown** (gray) state v1
  didn't need: a bucket whose policy flag is unsynced/denied AND whose versioning is unknown
  must not silently render as Standard. Block click opens the SAME DetailPanel the table
  uses (an `onSelect` callback wired from the page); a legend row explains the colors; the
  500-row `(표본 기준)` label applies (the page's one truncation signal).
- **L242** — two parts:
  - **Sync**: `iam_role` gains `attached_policy_arns` (verified against the pinned plugin
    source — a per-row `ListAttachedRolePolicies` hydrate; the role count is modest and the
    sync is quota-safe post-#267). Visible after the sync terraform apply + a sync run.
  - **Panel**: new `S3IamAccessSection` in DetailPanel (s3 rows only): fetches the SYNCED
    iam_role inventory via the EXISTING `/api/inventory/iam_role` route (no new route — no
    99-route churn; the data is already visible to the same authenticated user) and lists
    roles whose `attached_policy_arns` match S3-scoped or admin policies (`AmazonS3.*` /
    `AdministratorAccess`), max 30 (v1's cap). Honest bounds: a fetch failure renders an
    error line; roles synced WITHOUT the new column (pre-apply) render an explicit
    "정책 목록 미동기화" state, never an empty "no roles have access" claim.

## Testing
- S3BucketMap: precedence (public beats versioned), unknown state, region grouping, click
  callback, legend.
- S3IamAccessSection: policy matching (S3-scoped + AdministratorAccess), 30 cap, the
  pre-sync unknown state vs a genuine empty result.
- Sync: iam_role SELECT carries attached_policy_arns.
- Full `npm test` + `tsc` + build + `pytest scripts/v2/{workers,steampipe}`; component counts
  107 → 109; gap-audit ticks + batch-35 note; CHANGELOG EN/KO; docs-site 4 locales.
