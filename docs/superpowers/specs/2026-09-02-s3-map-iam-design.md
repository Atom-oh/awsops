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
  didn't need: an UNKNOWN policy flag always renders Unknown (even with known versioning —
  a denied policy lookup must not paint a reassuring color), and public-false with unknown
  versioning is Unknown too (as amended by round 1). Block click opens the SAME DetailPanel the table
  uses (an `onSelect` callback wired from the page); a legend row explains the colors; the
  500-row `(표본 기준)` label applies (the page's one truncation signal).
- **L242** — two parts:
  - **Sync**: `iam_role` gains `attached_policy_arns` (verified against the pinned plugin
    source — a per-row `ListAttachedRolePolicies` hydrate; ADR-010's list-hydrate rule is
    AMENDED in this PR with the TRUE failure semantics: an SCP-blocked hydrate fails the
    WHOLE iam_role run for all accounts (last-good rows preserved but frozen, status failed —
    the accepted, disclosed blast radius; the consuming section surfaces the run status)).
    Visible after the sync terraform apply + a sync run.
  - **Panel**: new `S3IamAccessSection` in DetailPanel (s3 rows only): fetches the SYNCED
    iam_role inventory via the EXISTING `/api/inventory/iam_role` route (no new route — no
    99-route churn; iam_role is an ADMIN-ONLY type, so the section shows a distinct
    permission note to non-admins rather than pretending to be a generic failure) and lists
    roles whose `attached_policy_arns` match the checked set — `AmazonS3*` /
    `AdministratorAccess` / `PowerUserAccess` / `ReadOnlyAccess`, job-function paths
    included, partition-tolerant anchor (as amended by rounds 2–3) — max 30 (v1's cap),
    with matched-set framing on the empty state (other policies can also grant S3). Honest bounds: a fetch failure renders an
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

## Round-2 corrections (review-driven)

- **The degrade contract is stated truthfully (the L4/L5 gate MAJORs)** — round 1's ADR-010
  amendment claimed a per-account `partial` demotion that does not exist: a Steampipe hydrate
  exception fails the ENTIRE iam_role run for all accounts (pruning skipped, last-good rows
  frozen, status `failed`). The ADR-010 amendment, the ko/zh/ja iam.md boxes, and a NEW en
  iam.md box (closing the pre-existing locale asymmetry) now state exactly that, with the
  whole-type freeze accepted as the disclosed risk.
- **The section consumes `run.status`/`finished_at` (the L3 gate MAJOR)** — a non-succeeded
  last run renders a stale-data banner, the conclusive "no role has access" line requires a
  succeeded, untruncated run, and `rows: []` distinguishes "no roles exist" (succeeded run)
  from "no data yet".
- Minors: the policy regex adds `PowerUserAccess` and the `job-function/` path (still
  anchored to the aws-managed prefix); the spec's L241 decision text matches the
  unknown-first implementation; the accountId prop's host-vs-'self' caveat is documented at
  the consumption site (s3 rows carry no account_id today — the 'self' default is exactly
  where host iam_role rows live).

## Round-3 corrections (review-driven)

- **`run: null` is not healthy (the gate MAJOR)** — the conclusive empty state now requires
  `run.status === 'succeeded'` explicitly; a missing ledger row (pre-ADR-021 data) renders
  the non-conclusive wording. Render tests pin run:null/succeeded/failed/403 paths.
- **Matched-set framing + ReadOnlyAccess (the gate MAJOR)** — `ReadOnlyAccess` (which grants
  s3:Get*/List*) joins the checked set with a partition-tolerant anchor, and the conclusive
  line/footnote say "no role matched the CHECKED policies" instead of "no role has S3
  access" (other managed policies can also grant S3). Three superseded i18n entries removed.
- **ADR-010 reads as one policy (the gate MAJOR)** — the §Consequences Positive/Negative and
  §Reliability lines now carry the 2026-09-02 exception with the whole-type-freeze blast
  radius; the blocked-API list gains the ListAttachedRolePolicies note.
- **s3.md (4 locales) states the shipped contract (the gate MAJOR)** — admin-only, the full
  checked policy set, and the run-status gating; the legend notes green/cyan are
  policy-scoped too (ACL exposure is separate).

## Round-4 corrections (review-driven)

- **The hydrate budget is real, not asserted (the L4 gate MAJOR)** — the "quota-safe
  (ADR-021)" comment claimed a budget ADR-021 never validated for this path. The sync
  Lambda's timeout is raised 120s → 300s (Terraform, with the math in the comment: one
  ListAttachedRolePolicies per role through the shared 2 req/s limiter ≈ 50s worst-case for
  ~100 roles, and 120s left only ~240 permits for ALL concurrent type syncs combined); the
  sync comment now carries those numbers and the ADR-010 failure semantics instead of the
  blanket claim. A remaining-time guard / running-state reaper is noted as a follow-up.
- **The how-to line matches the feature (the L5 gate MAJOR)** — s3.md's "Check IAM
  Permissions" step in all 4 locales no longer promises per-bucket access analysis: it now
  says account-wide roles holding broad S3 managed policies, admin-only, same list on every
  bucket.
- **troubleshooting.md / test-coverage-plan.md follow the amendment (the L5 gate MAJOR)** —
  both now offer the ADR-010 2026-09-02 accept-and-disclose path beside column removal, and
  the test invariant names the currently-accepted columns.
- **The compensating-control claim is scoped (the L5 gate MAJOR)** — ADR-010 + the 4 iam.md
  boxes now say the S3 access SECTION surfaces the run status (the general iam_role
  inventory page's run-status exposure is an acknowledged follow-up — its RefreshButton
  reads finished_at, which a failed run also stamps).
- Follow-ups noted, not shipped: an age gate on the conclusive empty state (a years-old
  succeeded run still reads conclusive); PAB/ACL-informed at-risk tile state.

## Round-5 corrections (review-driven)

- **Freshness bound on the conclusive all-clear (the gate MAJOR)** — a months-old succeeded
  run no longer renders a conclusive security conclusion: conclusive now requires the run to
  be succeeded, untruncated AND within 24h, and a data-as-of timestamp rides the footer.
  Tests pin the stale-succeeded → non-conclusive path.
- **The hard-timeout ledger hole is closed at the DB (the gate MAJOR)** — `_steampipe()` sets
  `statement_timeout = 240s` (below the 300s Lambda budget): a runaway hydrate query is
  killed by Postgres, control returns, and the run records `failed` with last-good rows
  preserved — instead of the process dying with the ledger stuck non-terminal.
- **BASELINE.md ADR-010 row amended in the same PR (the gate MAJOR)** — the dated
  flat-ban→risk-accept change is now live per BASELINE §1's anti-drift rule; the ADR's
  Status line records the amendment and §2's first bullet cross-references it.
- Minors: the misleading normalizeAccount comment corrected (the generic route has no
  host-id normalization — a future account-stamping s3 sync must map to 'self');
  troubleshooting gains a distinct ListAttachedRolePolicies row; the 8 reviewer/agent rule
  files reference the amendment; s3.md's conclusive condition states 24h+untruncated in 4
  locales; CHANGELOG EN gains the unknown-first clause (KO parity); the EN iam.md box drops
  the unintroduced summary-query sentence.
