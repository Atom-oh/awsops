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
    source — a per-row `ListAttachedRolePolicies` hydrate; ADR-010's list-hydrate rule is
    AMENDED in this PR: with ADR-021's degrade machinery an SCP-blocked hydrate now demotes
    that account's sync to partial instead of hard-failing). Visible after the sync terraform
    apply + a sync run.
  - **Panel**: new `S3IamAccessSection` in DetailPanel (s3 rows only): fetches the SYNCED
    iam_role inventory via the EXISTING `/api/inventory/iam_role` route (no new route — no
    99-route churn; iam_role is an ADMIN-ONLY type, so the section shows a distinct
    permission note to non-admins rather than pretending to be a generic failure) and lists
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

## Round-1 corrections (review-driven)

- **The drill-down is account-scoped, truncation-honest, and 403-aware (three gate MAJORs)**
  — the section now passes the bucket's `account_id` (a member-account bucket no longer
  lists host roles — the RdsSgRulesSection pattern), labels a >=500-row page `(표본 기준)`
  and words its empty state as non-conclusive under truncation, and renders a distinct
  admin-only note on 403 (iam_role is ADMIN_ONLY — the spec's original "already visible to
  the same user" rationale was wrong and is amended above).
- **bucketStatus is unknown-first (the gate MAJOR)** — an unknown public flag now yields
  Unknown even when versioning is known (a denied policy lookup must not paint a reassuring
  green), and public-false + versioning-unknown is Unknown too (Standard also claims
  not-versioned); the legend reads 'Policy Public' (policy-scoped, matching the column's own
  qualifier).
- **ADR-010 amended in the same PR (the gate MAJOR)** — the list-hydrate removal rule
  softens to risk-disclosure under ADR-021's partial-degrade (dated 2026-09-02 amendment);
  docs-site iam.md's SCP box updated in ko/zh/ja (EN never had the box — pre-existing locale
  asymmetry); the policy regex anchors on the aws-managed prefix (a customer 'AmazonS3Deny*'
  policy must not count as access).
- Docs: the residual 'TreeMap' heading/legend/usage strings swept in 4 locales with the
  Unknown legend row and the Policy-Public qualifier.
