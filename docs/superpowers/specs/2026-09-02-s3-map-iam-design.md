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
    AMENDED in this PR. Failure semantics as amended by round 8: a failed hydrate (SCP block
    or aggregate-role-count budget timeout) triggers ONE hydrate-free retry — the base
    inventory stays live, only the column is absent, and the run is disclosed degraded via
    unknown_attribute_count [round 9]; the whole-type last-good freeze on this path requires the
    base query to also fail (final run status otherwise follows the normal lifecycle —
    round 11); the consuming section surfaces the run status). Visible after the
    sync terraform apply + a sync run.
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
- **The hard-timeout ledger hole is NARROWED at the DB (the gate MAJOR)** — `_steampipe()` sets
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

## Round-6 corrections (review-driven)

- **The rows:[] empty branch is freshness-gated too (the gate MAJOR)** — 'no roles exist'
  now requires the same fresh-succeeded gate as the zero-hits branch (a months-old succeeded
  run rendered a current-tense all-clear).
- **The as-of timestamp is the DATA time (the gate MAJOR)** — `readResources` now selects
  `last_success_at` (written by the sync ledger; `finished_at` is merely the last ATTEMPT —
  a failed run stamps it too); the footer, the stale banner, and the 24h freshness check all
  use it.
- Minors: the quick-ref table cell is well-formed and the swept rule-file notes say 'v2 sync
  only'; architecture-decisions' unconditional removal line carries the amendment cross-ref;
  the FAQ's 'blocked APIs simply render empty' claim gained the hydrate exception in ko/en (round 6 — zh/ja were MISSED there, corrected in round 7); the round-5 'closed at the DB' wording is corrected to 'narrowed' (a
  near-240s query still races Aurora work against the 300s wall — the remaining-time
  guard/reaper stays a follow-up).

## Round-7 corrections (review-driven)

- **The ja/zh FAQ carries the hydrate exception too (the gate MAJOR)** — round 6 amended
  ko/en but MISSED the equivalent ja/zh sentences (a grep with the wrong phrasing), and the
  round-6 note falsely recorded that ja/zh never had the claim. Both locales now state the
  whole-type-freeze semantics, and the round-6 note is corrected in place.
- The gap-audit L242 tick's '버킷 계정 스코프' wording is softened to the actual contract
  (s3 rows carry no account_id today — the prop is a documented future-sync hook, and the
  'self' default is exactly where host iam_role rows live).

## Round-8 corrections (review-driven)

- **The hydrate budget closes via a hydrate-free fallback (the gate MAJOR)** — the verified
  arithmetic (aggregator = the role total across ALL connected accounts; 2 req/s shared
  limiter; 240s ≈ ~480 hydrates, less under concurrent syncs) meant fleets above ~400 roles
  hit a PERMANENT whole-type iam_role failure — a regression to a pre-existing feature with
  no run-status surface on the general IAM page. The fix restructures the failure mode
  instead of just re-sizing it: the hydrated query runs under a tighter 180s statement
  timeout (~360 aggregate hydrates when the limiter is idle), and ANY failure triggers one
  retry with the SAME query minus the hydrate column (90s) — the base iam_role inventory
  never regresses, the run records succeeded, and only the drill-down column is absent,
  which S3IamAccessSection already renders as the non-conclusive "not synced" state. An
  `inventory_sync_hydrate_fallback` log event names the limiter `fill_rate` knob (0.1–20,
  ADR-021) as the operator's restore path. Whole-type last-good freeze now applies ONLY when
  the base query also fails. ADR-010/BASELINE/iam.md(4)/faq(4)/guides/CHANGELOG/audit-note
  all restate the corrected semantics (iam_user.mfa_enabled keeps the no-fallback whole-type
  semantics — stated explicitly). Tests pin: fallback SQL ≡ primary minus the column, the
  180s/90s split, the retry control flow, no retry for non-hydrate types, and the
  statement_timeout closed-set guard.
- **run:null with matches is caveated (MINOR)** — a missing ledger row now renders an
  unverifiable-freshness note above the list instead of an implicitly-current list.
- Noted, not shipped (MINOR): client-clock freshness (`Date.now()` can misclassify under
  skew — server-side classification is the tighter follow-up); a 500-row full-payload fetch
  where a projection would do (data-minimization follow-up).

## Round-9 corrections (review-driven)

- **A fallback run is DISCLOSED, not silently healthy (the L4 gate MAJOR)** —
  `_run_steampipe_query` now returns a fallback-used flag and `sync()` records the run's
  `unknown_attribute_count` as the row count, riding ADR-021's existing
  `succeeded+unknowns→degraded` freshness machinery (ledger column → terminal event → the
  MCP reader's `query_inventory`/`inventory_summary`) — the exact channel SDK collectors
  already use, so no new contract. ADR-021's observability section and the
  steampipe-quota-and-staleness runbook §5 event list gain the
  `inventory_sync_hydrate_fallback` event with the budget split.
- **Query budgets clamp to remaining Lambda time (the L2 gate MAJOR)** — the Lambda timeout
  rises to 420s (≤180s hydrated + ≤90s fallback + ≥150s Aurora reserve), and every
  statement-timeout is additionally clamped to
  `remaining − AURORA_RESERVE_S(120) − (the fallback's own budget when applicable)` via a
  deadline armed from `context.get_remaining_time_in_millis()`; a sliver refuses up-front
  (recording `failed` cleanly) instead of racing the wall and stranding the ledger at
  `running`. The `_steampipe` timeout guard is a real `ValueError` raised BEFORE connecting
  (no `-O` elision, no leaked connection).
- **Remediation guidance is cause-specific (the L5 gate MAJOR)** — the log event's remedy,
  ADR-010 §2, and the iam.md boxes (4 locales) now split: statement timeout → raise the
  limiter `fill_rate`; SCP/IAM denial → grant `iam:ListAttachedRolePolicies` (rate tuning
  cannot fix a denial).
- **The contradicting docs state one semantics (the L5 gate MAJOR)** —
  `docs/guides/troubleshooting.md`'s ListAttachedRolePolicies row and this spec's §Decisions
  L242 bullet now state the round-8 fallback semantics; the ListMFADevices row says the
  column is retained without a fallback (whole-type semantics) rather than prescribing
  removal.
- Minors: ADR-010's blocked-API table gains the `aws_iam_role`/`ListAttachedRolePolicies`
  row; test-coverage-plan frames `mfa_enabled` as the pre-existing precedent; the two
  English-only `.claude` reviewer files' notes are English; the conclusive zero-match line
  carries the data-as-of timestamp (CHANGELOG-promised footer parity); CHANGELOG EN/KO
  amended in place with the degraded-freshness disclosure.
- Noted, not shipped: counting unhydrated rows under a `partial` run before the caveated
  list (round-9 L2 minor); client-clock freshness and the 500-row projection stay follow-ups.

## Round-10 corrections (review-driven)

- **The reachability probes are clamped too (the L2/L4/L5 gate MAJOR)** — round 9's "every
  query is remaining-time-clamped" claim missed `_account_reachable()`: the prune-phase probe
  called `_steampipe()` bare, inheriting the 240s default AFTER the main budgets — the one
  query left that could race the 420s wall and strand the ledger at `running`. The probe now
  gets `REACHABILITY_PROBE_TIMEOUT_S = 30` clamped via `_query_budget_s`, and when even that
  cannot fit ahead of the Aurora reserve it refuses WITHOUT connecting and reports
  unreachable — the conservative direction (last-good rows protected, run records partial).
  The Terraform comment, runbook, and this spec now state the corrected, complete claim.
- **The fallback log is sanitized (the L3/L5 gate MAJOR)** — `error=str(exc)[:400]` violated
  the file's own contract and ADR-021's "only a safe error_category/type, never raw text"
  (a Postgres-surfaced IAM denial embeds role ARNs/account IDs/SQL). The event now carries
  `error_category` (denial | statement_timeout | other, via `_hydrate_fallback_cause`) +
  `error_type` only; a test pins that a leaky AccessDenied message never reaches the log.
- Minors fixed: the unreachable-partial `inventory_sync_complete` event now carries
  `unknown_attribute_count` (a fallback can coincide with a partial); the FAQ (4 locales)
  states both remedies (fill_rate for timeouts, permission grant for denials); ADR-021 gains
  the definitional extension (the fallback routes transient hydrate failures into
  succeeded+unknowns too — self-healing next cycle, by design); the "≥150s reserve" wording
  now distinguishes the 120s dynamic clamp reserve from the 30s static slack.
- Noted, not shipped: an exactly-500-row fleet is permanently non-conclusive (safe
  direction; a cap+1 sentinel fetch is the tidier follow-up); `AmazonS3[A-Za-z]*` matching
  S3-family specialty policies (over-inclusion in an advisory, matched-set-framed list);
  client-clock freshness and the 500-row projection stay follow-ups.

## Round-11 corrections (review-driven)

- **The ADR-021 amendment is registered (the gate MAJOR)** — this PR substantively changed
  ADR-021's observability contract (new `inventory_sync_hydrate_fallback` event, the
  `unknown_attribute_count` definitional extension, a new field on the partial complete
  event) without touching its Status line or BASELINE §3 row — the same anti-drift rule this
  PR applied to ADR-010. Both now carry a dated "Amended 2026-09-02" marker, and ADR-021
  §Operational observability's "only `unreachable_account_count`" partial-event enumeration
  is corrected to include `unknown_attribute_count`.
- **Run-status absolutes are corrected to the real lifecycle (the gate MAJOR)** — "run
  `succeeded`" / "ONLY a base-query failure records `failed`" contradicted base `sync()`: a
  successful fallback coinciding with unreachable accounts records `partial`, and a
  later-stage Aurora upsert/prune/finalizer error records `failed` even after a successful
  fallback query. ADR-010 §2, iam.md ×4, the FAQ ×4, CHANGELOG EN/KO, this spec's §Decisions
  bullet, and the sync comment now say: the hydrate failure itself never decides the run
  status; the final status follows the normal lifecycle.
- Minors: docs-site truncation boundary "≤500" → "<500" (4 locales — exactly-500 is treated
  truncated); `_steampipe` passes a socket `timeout=statement_timeout_s+15` so connection
  SETUP is bounded too (sized above the statement budget — pg8000's socket timeout also
  ticks while waiting for results, so the server-side statement_timeout must fire first);
  the runbook's pre-existing "`degraded=false` 유지" sentence is corrected in place (code
  sets `degraded: bool(unknowns)`).
- **Tracked follow-ups (round-11 §4, consolidated):** deadline-aware post-query Aurora work
  or a stale-`running` reaper for `inventory_sync_runs` (the reserve is sized, not
  enforced); cap+1 sentinel fetch for the exactly-500 case; server-side freshness
  classification (client-clock skew); a server-side projection for the 500-row iam_role
  fetch; an exact policy allowlist instead of `AmazonS3[A-Za-z]*`.
