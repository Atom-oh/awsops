# Per-account inventory trend scoping + derived security-count historization — 2 gap-audit items (L124, L129)

**Status:** Batch 41, 2026-09-04 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch41`.
**WA pillar:** Operational Excellence (the trend chart follows the account selector; security
posture becomes a time series).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L124 (v2 trend/summary is
account_id='self' fixed while inventory_resources carries target-account data), L129 (v1
snapshots historized derived security counts and K8s counts as trend series; v2 snapshots
only raw synced resource_type counts).

## Decisions

- **L124 — snapshots become per-account at the WRITER** (`sync_lambda.py`): the daily
  inventory_snapshots write generalizes from the single `'self'` row to one row per account in
  `present` — the exact same trusted-account set both prune phases use (rows returned OR
  reachability-probed), so a snapshot is never written for an account whose data this run
  cannot vouch for (an unreachable account keeps its earlier same-day row: the DELETE is
  per-account, not blanket). An account in `present` with zero rows gets a genuine 0 row —
  key-absence stays the no-successful-sync signal the chart's coverage-parity logic relies on.
  SDK syncs are host-only and unchanged in effect (`present` ⊆ {'self'} there).
- **Trend route accepts `accounts`** (same vocabulary as `/api/inventory/summary`: absent →
  `['self']` for compatibility, `__all__`, or a CSV validated to `self`/12-digit) via a
  parameterized `account_id = ANY($n)`. **No region dimension** — snapshots don't carry one;
  the route ignores `regions` and the page keeps its existing region-default gating for the
  KPI/impact rows built on trend data. **History disclosure**: rows for non-self accounts only
  exist from this deploy forward; earlier dates simply lack the columns (honest absence, no
  backfill fabrication).
- **L129 — derived counts historized by running the WEB'S OWN predicates**: the sync lambda
  already talks to Aurora, so after upsert+prune it COUNTs `inventory_resources` per account
  with predicates copied verbatim from `web/lib/security-findings.ts` (`PUBLIC_S3_WHERE` /
  `FINDING_SQL` — two-way lockstep comments), writing three derived series:
  `public_s3_buckets` (rides the `s3_public_access` sync), `open_security_groups`
  (`security_group`), `unencrypted_ebs` (`ebs_volume`). The trend series therefore counts
  exactly what the /security page lists — no second Python definition to drift.
- **Derived series are excluded from the trend `total`** (they'd double-count the underlying
  resources) but appear as normal chart series/delta-table rows. Shared
  `DERIVED_TREND_TYPES` map (key → v1-parity English label, `web/lib/trend-utils.ts`) is used
  by the route (total exclusion) and the home page (labels — these keys are not inventory
  types, so `INV_LABEL`'s registry fallback would otherwise show raw keys).
- **Page wiring**: both trend fetches (chart `days=N`, impact `days=35`) pass the account
  scope; the 7d-net-change KPI and cost-impact rows relax their gate from "whole scope is
  default" to "regions/includeGlobal are default" (accounts are now genuinely scoped in the
  data; regions still are not).
- **Disclosed deviations** (recorded in the audit ticks):
  - L129's K8s counts (EKS Nodes / K8s Pods / Deployments) are NOT historized — v2 has no
    batch K8s collection (EKS reads are live, on-request `eks-incluster` calls; the sync
    lambda has no cluster access path), and a scheduled cluster sweep is a separate product
    decision. ECS Tasks/Services ARE already historized (synced `ecs_task`/`ecs_service`
    types appear as trend series today).
  - snapshots have no region dimension — account scoping only (same as before, now stated).
  - `public_s3_buckets` counts buckets matching the shared PUBLIC_S3_WHERE (policy-public OR
    a Block-Public-Access guard off); unknown (denied-attribute None) buckets don't count —
    the count is "confirmed public", consistent with the /security page.

## Testing
- pytest (steampipe): per-account rows over `present` (zero-count row included; absent
  account's same-day row untouched); derived-count SQL runs the lockstep predicate and writes
  rows; sdk_partial writes no snapshot rows (existing assertion holds); `_account_counts`.
- vitest: trend route `accounts` parsing (default self / `__all__` / CSV validation /
  parameterization) and derived-type exclusion from `total`; trend-utils map; account-scope
  param helper.
- Full `npm test` + `tsc` + build + `pytest scripts/v2/{workers,steampipe}`; audit ticks +
  batch-41 note; CHANGELOG EN/KO; api-reference row; docs-site home-dashboard guide note
  (4 locales) where behavior is user-visible.
