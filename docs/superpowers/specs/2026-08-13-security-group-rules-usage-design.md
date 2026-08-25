# Security Group Rules and Usage

**Status:** Approved (2026-08-19). The Feature Gate / IAM sections below previously self-classified
the Athena write-capable path (StartQueryExecution/StopQueryExecution + result-prefix S3 write + a
new cross-account role) as ADR-007-tier — that classification was this document's own reasoning, not
a ratified decision, and per BASELINE's own precedent (ADR-015) required a dedicated ADR + multi-AI
panel to settle. That ADR now exists:
[`docs/decisions/019-athena-flow-log-query-classification.md`](../../decisions/019-athena-flow-log-query-classification.md)
(Accepted 2026-08-19) reclassifies this feature as falling inside the existing read-only invariant
after a `/co-agent:consensus` multi-AI panel round (codex + kiro-cli/claude-fable-5) found, and this
document + the ADR resolved, several MAJOR gaps — including reconciling ADR-019's cross-account IAM
description with this document's own two-role design (§Feature gate, §IAM and multi-account
behavior). `docs/decisions/BASELINE.md` §2 now carries the `sg_rule_activity_enabled` register row
this document required. Owner: 오준석(Junseok Oh), who directed the ADR drafting and panel review
and approved this Status change after reviewing the findings and fixes.

## Summary

Split the current Security Groups experience into a collapsed Network navigation subgroup:

- **Security Groups** - existing SG inventory
- **Rules** - new flattened SGR inventory plus 30/90/180-day traffic evidence
- **Usage** - the existing SG-level ENI attachment and mutual-reference analysis moved out of the
  inventory page

The default Rules analysis window is 90 days. A daily internal job processes configured S3 VPC Flow
Log sources through Athena and persists compact, rule-level evidence in Aurora. The Rules page never
claims a rule is definitively unused. It uses:

- observed-compatible
- overlapping
- no observed evidence
- unassessable
- usage source not configured

No delete or revoke action is added.

## Correctness constraint: Flow Logs do not contain a matched SGR ID

The customer prompt proposed querying a `security-group-rule-id` field. That field is not part of the
VPC Flow Logs record schema. Therefore AWSops cannot attribute a flow to one exact SGR.

The engine instead compares each accepted flow tuple with the rule definitions and reports compatible
candidates. Multiple SGs and multiple overlapping rules can allow the same flow, security groups are
stateful, and historical ENI-SG membership can be incomplete. The UI and API must never describe this
as exact rule attribution.

This also corrects wording in the current upstream/v2 implementation:

- `web/lib/sg-analysis.ts` comments and UI strings that call Flow Logs rule matching "exact" become
  "compatible traffic matching".
- a single flow may increment more than one compatible rule; that is an overlap signal, not proof
  that every incremented rule was evaluated by AWS.
- `0` means no compatible observation in the inspected data, not unused.

## Existing upstream/v2 baseline

The design builds on the SG analysis introduced by upstream/v2 commit `dd63683e` and its review fixes
through the current v2 head:

- `web/lib/sg-analysis.ts`
  - SG usage from ENI attachment and SG mutual references
  - peer identification for CIDR, SG, internet, and prefix list
  - on-demand CloudWatch Flow Logs matching with NFM peer-only fallback
- `web/components/inventory/metrics/SgAnalysisSection.tsx`
  - SG-level KPIs and table
  - row-click traffic drilldown
  - 1h, 6h, 24h, and 7d range selector
- `web/app/api/sg/route.ts`
  - usage summary and selected-SG hits

That behavior remains available under the new Usage page.

## Navigation and pages

Network navigation:

```text
Security Group
  Security Groups
  Rules
  Usage
```

Routes:

- **Security Groups:** existing `/inventory/security_group`
- **Rules:** `/network/security-groups/rules`
- **Usage:** `/network/security-groups/usage`

The current `SgAnalysisSection` is removed from `web/app/inventory/[type]/page.tsx` and rendered on
the new Usage page. Its existing behavior and range selector are retained. The selected-SG drilldown
adds a link to Rules filtered by the SG ID.

The Rules page contains:

- all SGRs with `sgr-*` IDs
- SG, account, region, VPC, direction, protocol, ports, peer, and description
- traffic-evidence status
- compatible match count, overlap count, last observed time, effective coverage
- 30/90/180-day selector, default 90
- account, region, VPC, SG, direction, status, and text filters
- CSV/JSON export
- admin-only `Flow Log settings`
- admin-only `Refresh scan`
- row detail with evidence and a link to Path Check

## Flow Log source configuration

Many customers do not have VPC Flow Logs or Athena tables. AWSops does not create them.

An administrator configures each supported account and region inside Rules:

- account ID
- region
- Athena workgroup
- Glue database
- Glue table
- enabled state

The workgroup must already enforce a query-results S3 location. AWSops validates:

- workgroup exists and is usable
- database and table exist
- table location and schema are readable
- canonical VPC Flow Log fields can be resolved without administrator-supplied SQL
- the table exposes Glue partitions or partition projection that supports bounded time pruning
- the caller has Athena, Glue, and S3 access

Configuration is stored in Aurora and contains no credentials — the account/region source config
references a target account only; the actual query execution uses the purpose-named policy described
under **IAM and multi-account behavior** below, never `AWSopsReadOnlyRole` itself.
Missing configuration does not hide the Rule inventory. It sets activity to `not_configured`.

The minimum accepted schema resolves the AWS field names `interface-id`, `srcaddr`, `dstaddr`,
`srcport`, `dstport`, `protocol`, `action`, `log-status`, `start`, and `end`, including their common
Athena underscore-normalized forms. `flow-direction`, `tcp-flags`, `bytes`, and `packets` are
optional capabilities recorded in source validation. A table without a safe partition-pruning
strategy is rejected rather than scanned in full. Schema mapping and the discovered partition
strategy are generated by validation and stored in `validation`; users cannot provide arbitrary
column expressions or SQL.

## Feature gate

Add `sg_rule_activity_enabled`, default `false`.

When false:

- the Rules inventory can still be shown from live `DescribeSecurityGroupRules`
- Flow Log source configuration, scheduled scans, manual refresh, Athena IAM, and activity
  aggregation are disabled
- current Usage behavior remains unchanged

**2026-08-19 update: resolved.** The Athena `StartQueryExecution`/`StopQueryExecution` calls, the S3
write to the workgroup's results prefix, and the new cross-account `AWSopsSgRuleAthenaRole` (see IAM
section) are not read-only in the literal sense, and whether they required an ADR-007-tier
classification or fell under ADR-005's AWS-resource-mutation freeze was not this document's decision
to make. That classification now has its dedicated ADR, per BASELINE's ADR-015 precedent (a new ADR
+ multi-AI panel review, run inside a `/co-agent:consensus` session, 2026-08-19):
[`docs/decisions/019-athena-flow-log-query-classification.md`](../../decisions/019-athena-flow-log-query-classification.md)
(Accepted). It rules that this feature — including the two-role split this section and §IAM describe
(the reused `AWSopsReadOnlyRole` for rule inventory; the new, isolated `AWSopsSgRuleAthenaRole` for
the Athena/S3 write path) — sits inside the existing read-only invariant, needing neither an ADR-005
relaxation nor an ADR-007-tier designation. `docs/decisions/BASELINE.md` §2 now carries the
`sg_rule_activity_enabled` register row citing ADR-019.

This separates the new recurring Athena cost from the existing SG analysis.

## Data model

New ULID migration:

```sql
CREATE TABLE sg_flow_sources (
  id               bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id       text NOT NULL,
  region           text NOT NULL,
  workgroup        text NOT NULL,
  database_name    text NOT NULL,
  table_name       text NOT NULL,
  enabled          boolean NOT NULL DEFAULT true,
  validation       jsonb NOT NULL DEFAULT '{}',
  created_by_sub   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, region)
);

CREATE TABLE sg_rule_inventory (
  account_id       text NOT NULL,
  region           text NOT NULL,
  rule_id          text NOT NULL,
  group_id         text NOT NULL,
  is_egress        boolean NOT NULL,
  protocol         text NOT NULL,
  from_port        integer,
  to_port          integer,
  peer_kind        text NOT NULL,
  peer_value       text NOT NULL,
  description      text,
  fingerprint      text NOT NULL,
  first_seen_at    timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  active           boolean NOT NULL DEFAULT true,
  PRIMARY KEY (account_id, region, rule_id)
);
-- Review MAJOR (confirmed, 3 models): the sg_rule_inventory above is a mutable cache holding exactly
-- one current fingerprint per rule_id — fine for the Rules inventory page (current-state lookup), but
-- the matching engine needs to know "what did this rule look like when this flow was observed," which
-- a mutable cache cannot answer. The append-only version table below is the actual matching source of
-- truth; sg_rule_inventory stays a current-state-only cache.
CREATE TABLE sg_rule_inventory_versions (
  account_id       text NOT NULL,
  region           text NOT NULL,
  rule_id          text NOT NULL,
  fingerprint      text NOT NULL,
  group_id         text NOT NULL,
  is_egress        boolean NOT NULL,
  protocol         text NOT NULL,
  from_port        integer,
  to_port          integer,
  peer_kind        text NOT NULL,
  peer_value       text NOT NULL,
  -- Review MAJOR (confirmed, 2 models, round 12): valid_from/valid_to are observation timestamps (when
  -- the daily snapshot first/last saw this fingerprint), NOT rule-change timestamps — there is no
  -- CloudTrail-sourced mutation event here, only periodic DescribeSecurityGroupRules polling. Given
  -- the pipeline's own detection lag (rules are snapshotted on run day D+1, after day D's flows already
  -- happened — see "Why versioning" below), valid_from for a newly-detected fingerprint is *always*
  -- later than every flow timestamp in the day that triggered its detection, regardless of when the
  -- rule actually changed within that day. Comparing a single flow's `start` against `[valid_from,
  -- valid_to)` therefore cannot localize *when within a day* a change happened — every matching decision
  -- in this spec is made at day granularity (see "Why versioning"), never sub-day, and valid_from/
  -- valid_to should be read as "first/last day this fingerprint was confirmed present," not as a
  -- change-moment boundary.
  valid_from       timestamptz NOT NULL,
  -- NULL = currently open (not yet closed by the next observed fingerprint change).
  valid_to         timestamptz,
  PRIMARY KEY (account_id, region, rule_id, valid_from)
);
CREATE INDEX sg_rule_inventory_versions_lookup_idx
  ON sg_rule_inventory_versions (account_id, region, rule_id, valid_from, valid_to);

CREATE TABLE sg_eni_membership_snapshots (
  account_id       text NOT NULL,
  region           text NOT NULL,
  -- Review MAJOR (confirmed): without vpc_id, a peer-IP -> SG reverse lookup can match an ENI in a
  -- different VPC within the same account/region that happens to use overlapping RFC1918 space. The
  -- reverse-lookup query must always scope by vpc_id (confirm the target ENI's VPC first, then match
  -- IPs only within that VPC).
  vpc_id           text NOT NULL,
  observed_at      timestamptz NOT NULL,
  eni_id           text NOT NULL,
  group_ids        jsonb NOT NULL,
  private_ips      jsonb NOT NULL,
  PRIMARY KEY (account_id, region, observed_at, eni_id)
);
CREATE INDEX sg_eni_membership_snapshots_vpc_idx
  ON sg_eni_membership_snapshots (account_id, region, vpc_id, observed_at);

CREATE TABLE sg_rule_activity_daily (
  account_id              text NOT NULL,
  region                  text NOT NULL,
  rule_id                 text NOT NULL,
  rule_fingerprint        text NOT NULL,
  observed_on             date NOT NULL,
  compatible_match_count  bigint NOT NULL DEFAULT 0,
  compatible_bytes        bigint NOT NULL DEFAULT 0,
  overlap_match_count     bigint NOT NULL DEFAULT 0,
  unique_eni_count        integer NOT NULL DEFAULT 0,
  last_observed_at        timestamptz,
  coverage                jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (account_id, region, rule_id, observed_on)
);

CREATE TABLE sg_rule_scan_runs (
  id                    text PRIMARY KEY,
  flow_source_id        bigint NOT NULL REFERENCES sg_flow_sources(id),
  status                text NOT NULL,
  partition_start       timestamptz,
  partition_end         timestamptz,
  athena_query_id       text,
  data_scanned_bytes    bigint,
  rows_processed        bigint,
  coverage              jsonb NOT NULL DEFAULT '{}',
  error_code            text,
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz
);

CREATE INDEX sg_rule_scan_runs_partition_idx
  ON sg_rule_scan_runs (flow_source_id, partition_start, partition_end, started_at DESC);
```

`sg_rule_activity_daily`'s primary key is scoped to `(account_id, region, rule_id, observed_on)` —
`rule_fingerprint` is stored as a plain column, not part of the key. This is deliberate: a rule's shape
can change mid-lifetime, and a day's aggregate must have exactly one row regardless of how many
fingerprint epochs the rule passed through that day. Keying on fingerprint would let reprocessing a day
after a fingerprint change leave the old-fingerprint row in place alongside the new one, double-counting
that day in any per-rule range roll-up.

`sg_rule_scan_runs` intentionally has **no** uniqueness constraint on
`(flow_source_id, partition_start, partition_end)` — only a lookup index. Every scan attempt for a given
partition (daily retry, manual admin refresh, or a rerun after a failed run) inserts a **new** row; the
partition's current status is whichever row for that `(flow_source_id, partition_start, partition_end)`
has the latest `started_at`. A failed run's row is retained as history and never blocks the next attempt
from being inserted — the "reprocessing a day recomputes and replaces that day's aggregates" behavior in
the pipeline section below is about `sg_rule_activity_daily`, not an update-in-place on this run-log table.

Daily aggregates are retained for at least 400 days so the 180-day selector does not require a new
Athena query. Raw flow records are not copied into Aurora.

## Rule inventory

Use `DescribeSecurityGroupRules` with pagination. Do not reconstruct SGR IDs from
`DescribeSecurityGroups`, because the Rules page requires stable `sgr-*` identifiers.

The daily worker upserts `sg_rule_inventory` (the current-state cache used by the Rules page) and
independently maintains `sg_rule_inventory_versions` (append-only, used by matching — see Data model):
on every run, if a rule's freshly computed fingerprint differs from its currently-open version
(`valid_to IS NULL`) in `sg_rule_inventory_versions`, that version is closed (`valid_to = now()`) and a
new version row is inserted (`valid_from = now()`). A rule seen for the first time gets its first
version row with `valid_from = first_seen_at`. Missing-rule handling and first/last-seen tracking on
`sg_rule_inventory` are unchanged.

**Why versioning, not a day-level epoch flag — and why matching is day-granular, not per-flow.** The
daily pipeline snapshots current rules on run day D+1 (step 2 below) but scans Flow Log data for the
*prior* day D — so "the fingerprint captured at snapshot time" is never the shape confirmed in force
*during* day D unless the rule was untouched across the whole gap. A day-level "did the fingerprint
change today" flag on the old single-row cache can't express this at all (no fingerprint-change
timestamp exists to test), which is why `sg_rule_inventory_versions` exists.

**Round-12 self-check (this file's own reviewers caught this): per-flow `start`-vs-`[valid_from,
valid_to)` comparison cannot actually localize a change within a day, and an earlier version of this
spec claimed otherwise.** Because a fingerprint change is only *detected* on the D+1 snapshot — strictly
after every flow in day D has already happened — `valid_from` for a newly-detected version is always
later than every single-flow `start` timestamp within day D, regardless of whether the true change
happened at the start, middle, or end of day D. Comparing one flow's `start` against `valid_from` cannot
distinguish "this flow predates the change" from "this flow postdates the change but predates
detection" — both compare as "before `valid_from`." There is no cheap fix within a periodic-poll design
(only a CloudTrail-sourced SG-mutation event stream would give a real change timestamp, which is out of
scope for this spec).

Matching is therefore done at **day granularity**, not per-flow: for each `(rule_id, observed_on)` pair,
the worker checks whether a **single** `sg_rule_inventory_versions` row's `[valid_from, valid_to)`
interval covers **the entire day** being scanned (i.e. `valid_from <= start-of-day` and `valid_to IS
NULL OR valid_to > end-of-day`) — confirmed by the fingerprint being identical on both the snapshot taken
before day D started and the snapshot taken after it ended (D+1's snapshot, per the detection-lag
argument above). If it does, every flow that day matches against that one version with full confidence.
**If the version open at the start of day D differs from the version open at the end of day D — a
transition was detected somewhere in or before that day and its exact moment is unknowable — the whole
day's matches against that rule are `unassessable`, not attributed to either version with a "lower
bound" label.** Presenting a fabricated per-flow attribution as more precise than a coin flip is worse
than admitting the day can't be confidently matched; `sg_rule_activity_daily`'s
`coverage.fingerprint_epoch_crossing = true` flag exists to mark exactly this case, and — corrected from
an earlier draft of this section — it changes the day's `compatible_match_count`/`unique_eni_count` to
`unassessable` for that rule, not a lower-bound estimate, because there is no version we can honestly
attribute the day's flows to.

**Separately disclosed, narrower limitation**: even a day confidently matched to one version can still
misattribute a single *ongoing* connection if that connection began before the version's `valid_from`
but continues (with further Flow Log records) into or past a day matched to the new version — VPC Flow
Logs publish periodic records for long-lived connections, and this pipeline does no 5-tuple connection
correlation across records, so it cannot recognize "this is the same connection that started earlier
under the old rule." This is a distinct, narrower issue from the day-boundary problem above (which is
now fully avoided by day-granularity matching) — it only affects the rule-fingerprint *label* on
already-permitted continuing traffic, never the allow/deny outcome (Flow Log's own `action` field
already records what AWS actually permitted). Accepted as a bounded, disclosed imprecision; connection-
level correlation is out of scope for this spec.

**Follow-up correction (post-launch CI review, item 3): a single version technically covering the
whole day is still not always confident.** The day-granularity rule above checks that ONE version's
`[valid_from, valid_to)` spans start-of-day through end-of-day, but `valid_from`/`valid_to` are — per
the detection-lag argument above — *observation* timestamps (the run time of the scan that first/last
saw that fingerprint), not the actual change instant. If the version's `valid_to` is closed and falls
within one scan interval (the daily cadence between successive snapshots) of that day's own end, the
real change could have happened anywhere in `(valid_to - scan_interval, valid_to]` — a window that can
overlap the day being matched even though the version's *observation* interval technically spans it.
Concretely: a version closed at exactly the next day's midnight (`valid_to` = day D+1 00:00) was, under
a 24h scan cadence, possibly closed by a change that happened anywhere in the preceding 24h — i.e.
during day D itself — so day D cannot be confidently attributed to the version that merely appears to
cover it. `sm.day_coverage()` now folds this into the same `unassessable` outcome (never a lower bound)
whenever the covering version's `valid_to - observation_lag < end-of-day`; a still-open version
(`valid_to IS NULL`) is unaffected — a change that hasn't happened yet can't retroactively taint a day.

**Further follow-up correction (round-2 CI review, item 2): `observation_lag` is no longer a fixed
constant.** The paragraph above originally derived `observation_lag` from a fixed nominal cadence
(`SG_RULE_SCAN_INTERVAL_HOURS`, default 24h) — but that's wrong whenever scans are actually delayed
or missed for multiple days in a row: the real change could have happened anywhere in the WHOLE gap
since the previous successful scan, not just within one nominal cadence period (a Wednesday change
first observed Friday would otherwise leave Wednesday/Thursday confidently, and wrongly, attributed
to the old rule shape). `sg_rule_scan.py`'s `previous_successful_scan_gap()` now resolves the ACTUAL
elapsed gap to the previous successful `sg_rule_scan_runs` row for this source and passes THAT in as
`observation_lag`; when there's no reasonably recent previous successful run to compare against (the
very first scan for a source, or Athena scanning only just enabled), `observation_lag` is `None` and
`sm.day_coverage()` marks the day `unassessable` rather than guessing a window.

Default outbound rules are displayed and marked protected from cleanup recommendations.

## Daily pipeline

The daily dispatcher creates one internal job per enabled account/region source. Manual refresh uses
an admin-only dedicated route and the same job path.

For each source:

1. validate the saved source metadata
2. snapshot all current SGRs and ENI-SG memberships
3. calculate the next unprocessed completed UTC day from the discovered S3 partition scheme,
   **skipping any day less than `SG_RULE_DELIVERY_LAG_HOURS` (default 6h) old** — Flow Log delivery
   lags real time by minutes to hours, and scanning a day whose partition is still being written would
   silently read a partial day
4. run one Athena query for that account/region/day batch, not one query per SG or rule —
   the query's own PARTITION predicate widens to `{D, D+1}` (Hive partitions are keyed by delivery
   time, so a flow whose own `start` falls on day D can land in day D+1's partition file; the
   row-level `start`/`end` filter, not this predicate, is what still authoritatively decides which
   rows count as day D's traffic). This means the effective per-day scanned-PARTITION-file bound is
   up to double a single day's own partition size — size the workgroup's `BytesScannedCutoffPerQuery`
   (Feature gate / IAM sections) with that doubling in mind, not against a single day's partition
   alone
5. select and aggregate only fields needed for deterministic matching
6. match accepted flows against candidate ingress or egress rules
7. within one transaction: delete all `sg_rule_activity_daily` rows for
   `(account_id, region, observed_on)` and insert the freshly computed rows (current-fingerprint or
   not — the delete is scoped to the day, not to a fingerprint), and replace that day's scan coverage
8. advance the watermark only after the complete transaction succeeds

The generic `POST /api/jobs` rejects this job type. The dispatcher submits it only from the trusted
daily path or the admin refresh route.

The scan unit is one complete UTC day, even when the underlying table is partitioned hourly.
Backfill proceeds day by day. Reprocessing a day recomputes and replaces that day's aggregates via the
delete-then-insert in step 7; it never adds counts to existing rows. This makes retries and manual
refresh idempotent regardless of whether a rule's fingerprint changed since the day was last scanned.

Because the watermark only ever advances past a day once its transaction fully commits, and a day is
never eligible for scanning until it clears the delivery-lag grace period in step 3, an already-advanced
day is never revisited automatically. A scheduled re-scan of the trailing `SG_RULE_RESCAN_WINDOW_DAYS`
(default 2) days runs alongside the normal watermark advance, re-running the same idempotent
delete-then-insert for those days — this is the safety net for records that arrived late enough to miss
the lag grace period entirely (rare, but Flow Log delivery has no hard SLA). This rescan does not move
the watermark backward; it only refreshes already-committed days that are still inside the window.

## Match model

Input fields include the available equivalents of:

- interface ID
- source and destination address
- source and destination port
- IP protocol
- action
- log status
- start/end time
- flow direction when configured
- TCP flags when configured

Rule matching covers:

- IPv4 CIDR
- IPv6 CIDR when the source format supports it
- SG references, resolved against the **latest `sg_eni_membership_snapshots` row with
  `observed_at` at or before the end of the day being scanned, and no more than
  `SG_RULE_MEMBERSHIP_STALENESS_DAYS` (default 3) days older than that day** — not "same calendar day"
  (the daily pipeline snapshots current membership on run day D but scans flow data for an earlier day,
  so an exact-day match is frequently unsatisfiable by construction; nearest-prior-in-time is the
  correct semantics and mirrors how `sg_rule_inventory_versions` resolves rule shape). This staleness
  bound governs **normal same-window processing and the trailing rescan window** — a snapshot from
  weeks or months before an ordinarily-scanned day is not meaningfully "current" for that day and
  should not be used silently just because it's the only one available; outside the window, that day's
  SG-reference matches are `unassessable`.
  **This bound does not apply to the initial-historical-backfill case** (see "Initial historical
  backfill" below): a day older than the **earliest** snapshot this source ever took has no in-window
  snapshot by construction (snapshotting cannot retroactively exist before the source was configured),
  and for that case the design deliberately falls back to that same earliest snapshot rather than
  marking the day `unassessable` — labeled in the UI as "historical evidence mapped using the earliest
  available membership snapshot" (lower confidence), not silently equated with a normal, in-window
  match. This is pinned to a **fixed** reference (the earliest snapshot, which does not change once
  recorded) rather than "whatever's current/latest right now" — a floating "current" reference would
  drift every time this same historical day is reprocessed (retry, admin refresh, or the trailing
  rescan revisiting a day it doesn't actually own), since "current" keeps moving forward while the
  historical day being matched does not; that would silently violate the idempotent-reprocessing
  guarantee the rest of this pipeline relies on. The two rules are for two different situations: "we
  have a snapshot but it's too old to trust" (normal processing, `unassessable`) vs. "no snapshot could
  possibly exist yet for this day" (pre-snapshotting backfill, pinned to the earliest one, labeled
  lower-confidence).
  Scoped to **the flow's own VPC plus any VPC known to be able to legally reference it** — a VPC with an
  active VPC Peering connection to the flow's VPC, or a participant VPC in the same shared-VPC (RAM)
  arrangement, per this repo's existing VPC topology data — not simply the flow's own VPC alone (SG
  references are valid across peering and shared VPCs, so a same-VPC-only scope produces a false
  `no_observed_evidence` for every legitimately cross-VPC-referenced rule) and never scoped to "any VPC"
  (which is what let an ENI in an unrelated VPC match purely by coincidentally sharing the same RFC1918
  address). An ENI that resolves outside this VPC set is `unassessable`, not treated as a non-match.

  **Follow-up correction (round-2 CI review, item 5/6): "per this repo's existing VPC topology data"
  above is NOT data-backed today.** No `describe-vpc-peering-connections`/RAM data source exists in
  this repository yet (`sg_rule_scan.py`'s `process_day` docstring and its `peered_or_shared_vpc_ids_by_vpc`
  parameter say so directly), so the peering/shared-VPC PARTICIPANT SET this paragraph describes is
  currently always empty in practice — every SG-reference resolution effectively scopes to the flow's
  own VPC alone. This is the SAFE direction, not a broken feature: item 6's fix (see "Fixed" in the
  CHANGELOG) makes an SG reference to a `group_id` that resolves outside that (currently empty) known-
  legal scope but IS present somewhere else in the account/region's own membership snapshot data
  resolve `unassessable` — never a confident `no_observed_evidence` and never a false cross-VPC match.
  Populating `peered_or_shared_vpc_ids_by_vpc` from a real peering/RAM data source (closing the gap
  this paragraph originally implied was already closed) remains a scoped, undone follow-up.
- managed prefix lists when entries can be resolved read-only
- ingress and egress
- protocol and port ranges

Classification:

- `observed_compatible` - at least one accepted flow is compatible with this rule
- `overlapping` - a compatible flow also matches another rule or SG
- `no_observed_evidence` - no compatible flow in the selected range, with sufficient configured
  source and scan coverage
- `unassessable` - missing fields, missing partitions, incomplete membership history, unsupported
  peer type, source errors, or insufficient coverage
- `not_configured` - no enabled source for this account/region

Security-group statefulness means return traffic may not require a rule in the observed direction.
TCP flags can improve initiator inference but do not make attribution exact. UDP and ICMP often
remain ambiguous. These limitations are shown in coverage and detail text.

When `flow-direction` is absent, AWSops may infer direction only when the tuple can be related
unambiguously to an IP on the selected ENI membership snapshot. NAT, transit, missing IP history,
and any other ambiguous case become `unassessable`; they are not forced into ingress or egress.

Initial historical backfill is partial because current EC2 APIs cannot reconstruct all historical
ENI-SG associations. The UI distinguishes:

- evidence collected after AWSops began snapshotting
- historical evidence mapped using the **earliest** membership snapshot this source ever took (not
  "current"/latest-at-run-time — that would drift every time the same historical day is reprocessed,
  since "current" keeps moving forward while the historical day it's being matched against does not,
  breaking the pipeline's own idempotent-retry guarantee for exactly the days this exception covers.
  Pinning to the earliest snapshot is a fixed reference: reprocessing the same pre-snapshotting day next
  month resolves against the same snapshot row and produces the same result, same as any other day)

No-observation results from the partial backfill remain lower confidence.

## APIs

- `GET /api/sg/rules`
  - filters and paginates Aurora inventory/activity
- `GET /api/sg/flow-sources`
  - authenticated read
- `PUT /api/sg/flow-sources`
  - admin-only create/update and metadata validation
- `POST /api/sg/rules/refresh`
  - admin-only async refresh
- existing `GET /api/sg`
  - Usage summary, unchanged
- existing `GET /api/sg?view=hits&id=...`
  - Usage row drilldown, with corrected "compatible" terminology

Input database, table, and workgroup identifiers are strictly validated and quoted. They are never
concatenated from an untrusted non-admin request.

## IAM and multi-account behavior

When the feature is enabled, the worker needs:

- Athena Start/Get/Stop query execution, scoped to configured workgroups where supported
- Glue GetDatabase/GetTable/GetPartitions
- S3 read on the configured Flow Log table locations
- S3 write on the workgroup's query-result prefix only (required by Athena itself to run a query;
  scoped to that one prefix, never a general S3 write grant)
- EC2 DescribeSecurityGroupRules and DescribeNetworkInterfaces

`Athena StartQueryExecution`/`StopQueryExecution` and the query-result S3 write are not read actions.
`AWSopsReadOnlyRole` itself gains **no new permissions and no new policy of any kind** (managed or
inline) as part of this feature — a role whose name is a declared read-only invariant does not carry
write-capable actions under any attachment method, since the write capability is the same regardless of
whether it arrives as a managed policy or an inline one. Target accounts instead get a wholly separate
IAM role (e.g. `AWSopsSgRuleAthenaRole`), scoped to exactly the workgroup(s) and result prefix configured
for that source, explicitly excluding `s3:DeleteObject` and any bucket-policy/ACL write action; this is
exactly the two-role split ADR-019 §4 ratifies as still sitting inside the read-only invariant (see
Feature gate above) — the classification question is resolved, applied here at the IAM boundary the
same as at the flag. The host account uses its execution
role and does not self-assume.

**Trust policy** (this is the first write-capable role in a repo whose existing cross-account path is
entirely read-only, so nothing to copy from): the target account's `AWSopsSgRuleAthenaRole` trust policy
requires an `ExternalId` condition on the assuming principal (matching this repo's existing cross-account
convention in `terraform/v2/foundation/workload.tf` for the read-only role) plus an explicit principal
ARN restriction to the host account's Athena-worker identity — no wildcard principal, no missing
ExternalId, which would otherwise make this a confused-deputy risk the read-only sibling role never had.

**Assumption path — cannot reuse the shared Fargate worker task role as-is.** `terraform/v2/foundation/
workers.tf` and `scripts/v2/workers/handlers.py` show `report`, `compliance`, and other job handlers
share one Fargate task role/task definition. Granting *that* role `sts:AssumeRole` on
`AWSopsSgRuleAthenaRole` would expose every job type this worker fleet runs — not just this feature — to
Flow Log S3 reads, Athena execution, and result-prefix writes, making "assumed only by this feature's
worker path" a documentation claim with no IAM enforcement behind it. This feature's Athena-executing
work needs either (a) a dedicated task role/task definition (a separate Fargate service or a distinct
container definition within the existing task, so `sts:AssumeRole` on the Athena role is scoped to that
role alone) or (b) a broker Lambda that is the only principal allowed to assume `AWSopsSgRuleAthenaRole`,
with the Fargate worker calling the broker rather than assuming the role directly. Pick one before
implementation — this is not an optional hardening step, it's what makes the isolation claim true.

Missing permissions degrade only that account/region source to `unassessable`.

## Error handling

- no source -> inventory visible, activity `not_configured`
- invalid source schema -> source `invalid`, no scan
- one account/region failure -> other sources continue
- Athena failure -> retain the last successful aggregate and mark it stale
- incomplete or missing day partitions -> do not advance the watermark
- partial ENI history -> lower coverage, never authoritative zero
- `SKIPDATA` -> coverage warning
- table schema drift -> validation failure until an admin updates the source
- mapping ambiguity -> `overlapping`, not multiple exact hits
- stale job -> existing reaper marks it failed
- evidence overflow -> retain bounded totals and set `truncated=true`

## Testing

### Matching

- CIDR, IPv6, SG reference, prefix list, protocol, and port-range cases
- overlapping SG and overlapping rule cases
- ingress and egress
- TCP initiator and return-flow ambiguity
- UDP/ICMP ambiguity
- rule fingerprint changes
- default outbound protection

### Pipeline

- source validation
- partition watermark idempotency
- delivery-lag grace period is honored before a day becomes eligible
- rescan window re-processes a trailing day without moving the watermark backward
- rule-fingerprint change mid-window: day replace clears the prior fingerprint's row for that day
- a day whose start-of-day and end-of-day versions differ sets `coverage.fingerprint_epoch_crossing`
  and downgrades that rule's counts for the day to `unassessable` — never a "lower bound" number
- a day whose start-of-day and end-of-day versions agree matches confidently with no crossing flag
  — UNLESS that covering version's `valid_to` is closed and falls within `observation_lag` of the
  day's own end, in which case the day is `unassessable` per the "Follow-up correction (item 3)"
  above (the observation-timestamp uncertainty window can overlap this day even though a single
  version's interval technically spans it); a version transition on an adjacent day that stays
  outside that window still leaves the day confidently matched
- per-flow `start` is never compared directly against `valid_from`/`valid_to` for matching (a single
  flow's timestamp cannot localize a change within a day given the pipeline's own detection lag — see
  "Why versioning"); matching is decided once per `(rule_id, observed_on)`, not per flow
- ENI-membership snapshot lookup: in-window (used), stale beyond `SG_RULE_MEMBERSHIP_STALENESS_DAYS`
  (`unassessable`), and pre-snapshotting backfill day (pinned to the earliest snapshot, labeled
  lower-confidence) are three distinct outcomes, not one collapsed into another
- reprocessing the same pre-snapshotting backfill day twice, with a new (later) snapshot taken in
  between the two runs, produces the same result both times (pinned to the earliest snapshot, not to
  whatever is current at each run) — the idempotent-retry regression this fix exists to prevent
- concurrent/retried run for the same partition does not block on a uniqueness conflict
- one account/region batch rather than per-rule query
- Athena pagination and terminal states
- scan transaction rollback
- stale-last-known-good preservation
- partial coverage classification
- initial backfill confidence
- cross-account failure isolation

### Authorization

- source mutation and manual refresh require admin
- read routes require authentication
- generic jobs route rejects the job type
- feature gate fails closed

### UI

- Security Groups no longer embeds `SgAnalysisSection`
- Usage renders the moved existing analysis and hit drilldown
- Rules renders configured, unconfigured, partial, stale, overlapping, and no-evidence states
- no deletion control exists
- account/region filters and 30/90/180-day windows
- deep links between Usage, Rules, SG inventory, and Path Check
- desktop and mobile text do not overlap

## Verification

1. `cd web && npx vitest run`
2. focused worker pytest suite
3. `cd web && npm run build`
4. `terraform -chdir=terraform/v2/foundation validate`
5. gate-off Terraform plan has no new scheduler, IAM, or worker resources
6. configured test source scans one bounded partition and writes Aurora aggregates
7. rerunning the same partition is idempotent
8. source failure leaves the previous result visible as stale
9. Playwright screenshots cover all three Security Group menu pages

## Explicit exclusions

- no SG or SGR deletion
- no Flow Log, S3 bucket, Glue table, Athena workgroup, or partition creation
- no exact matched-rule claim
- no arbitrary SQL supplied by users
- no raw Flow Log storage in Aurora
- no autonomous remediation
