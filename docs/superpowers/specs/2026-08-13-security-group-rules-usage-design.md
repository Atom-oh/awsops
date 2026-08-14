# Security Group Rules and Usage

**Status:** Proposed 2026-08-13 — **not yet Approved.** The Feature Gate / IAM sections below classify the Athena write-capable path (StartQueryExecution/StopQueryExecution + result-prefix S3 write + a new cross-account role) as ADR-007-tier rather than ADR-005 FROZEN. That classification is this document's own reasoning, not a ratified decision — per BASELINE's own precedent (ADR-015 required a dedicated ADR + multi-AI panel + dated owner-override for a single narrowly-scoped `ecs:UpdateService` call), the instrument for settling this is a new ADR through that same process, not an Approved design spec. This document does not move to Approved, and the BASELINE §2 row it requires does not get written, until that ADR lands. Implementation must not start from this spec while it is Proposed.

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

**This flag cannot be implemented yet.** The Athena `StartQueryExecution`/`StopQueryExecution` calls,
the S3 write to the workgroup's results prefix, and the new cross-account `AWSopsSgRuleAthenaRole` (see
IAM section) are not read-only, and whether they fall under ADR-007 (external/customer-owned DATA,
narrowly-scoped write confined to the caller's own resources — this document's own working hypothesis,
by analogy to `diagnosis_notify_enabled`) or ADR-005's AWS-resource-mutation freeze is **not this
document's decision to make**. Per BASELINE's own precedent (ADR-015 required a dedicated ADR + multi-AI
panel + dated owner-override for one narrowly-scoped `ecs:UpdateService` call), that classification
requires a new ADR through the same process — not a design-spec assertion. Implementation, the
`docs/decisions/BASELINE.md` §2 register row, and this document's `Status:` all wait on that ADR landing
(same-PR anti-drift rule applies to the ADR, not to this spec).

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
-- 리뷰 MAJOR(확정, 3모델): 위 sg_rule_inventory는 rule_id당 현재 fingerprint 1개만 보관하는
-- mutable 캐시다 — Rule inventory 페이지(현재 상태 조회)에는 맞지만, 매칭 엔진이 "이 flow가
-- 관측된 시점에 이 rule의 모양이 무엇이었는가"를 알아야 하는데 mutable 캐시로는 알 수 없다
-- (스캔은 D-1일을 보는데 워커는 D일 실행 시점 rule 모양만 스냅샷하므로, D-1과 D 사이에
-- fingerprint가 바뀌었으면 D-1일의 실제 flow를 D일 모양으로 오귀속한다). 아래 append-only
-- 버전 테이블이 실제 매칭 기준이다 — sg_rule_inventory는 현재 상태 조회용 캐시로만 남는다.
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
  valid_from       timestamptz NOT NULL,
  -- NULL = 현재 활성 버전(아직 다음 fingerprint 변경으로 닫히지 않음).
  valid_to         timestamptz,
  PRIMARY KEY (account_id, region, rule_id, valid_from)
);
CREATE INDEX sg_rule_inventory_versions_lookup_idx
  ON sg_rule_inventory_versions (account_id, region, rule_id, valid_from, valid_to);

CREATE TABLE sg_eni_membership_snapshots (
  account_id       text NOT NULL,
  region           text NOT NULL,
  -- 리뷰 MAJOR(확정): vpc_id 없이 peer-IP → SG 역조회를 하면 같은 계정/리전 안에서 겹치는
  -- RFC1918 대역을 쓰는 서로 다른 VPC의 ENI가 매칭될 수 있다. 역조회 쿼리는 반드시
  -- vpc_id로 스코프한다(대상 ENI가 속한 VPC를 먼저 확정한 뒤에만 그 VPC 안에서 IP 매칭).
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

**Why versioning, not a day-level epoch flag.** The daily pipeline snapshots current rules on run day D
(step 2 below) but scans Flow Log data for an *earlier* day (D-1, or an arbitrary backfill day) — so
"the fingerprint captured at snapshot time" is never actually the shape in force during the scanned
day unless the rule happened to be untouched across the whole gap. A day-level "did the fingerprint
change today" flag can't express this, and there is no fingerprint-change timestamp on the old
single-row cache to even test the condition against. Matching therefore never asks "what does the rule
look like right now" — for each candidate rule match against a flow record, it looks up the
`sg_rule_inventory_versions` row for that `rule_id` whose `[valid_from, valid_to)` interval contains the
flow's own `start`/`end` timestamp (an open-ended `valid_to IS NULL` interval matches anything at or
after `valid_from`). If no version row's interval covers the flow's timestamp (the rule didn't exist
yet, or the version history has a gap from before this feature started recording it), that flow's match
against that rule is `unassessable`, not silently attributed to whatever fingerprint happens to be
current now. `sg_rule_activity_daily` continues to store the rule's fingerprint *as of the versions
looked up for that day's matching*, not a snapshot-time fingerprint — if a day's flows split across two
versions (the edit happened mid-day), the day's row records
`coverage.fingerprint_epoch_crossing = true` and its counts render as a lower bound, not an exact count
(same rendering as any other `unassessable`-adjacent coverage flag). This is a conservative degrade, not
a blocker: the row is still written and still contributes to trend/history views, just flagged.

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
4. run one Athena query for that account/region/day batch, not one query per SG or rule
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
  `observed_at` at or before the end of the day being scanned** (not "same calendar day" — the daily
  pipeline snapshots current membership on run day D but scans flow data for an earlier day, so an
  exact-day match is frequently unsatisfiable by construction; nearest-prior-in-time is the correct
  semantics and mirrors how `sg_rule_inventory_versions` resolves rule shape). If no snapshot exists at
  or before that day at all (the source is brand new), that day's SG-reference matches are
  `unassessable`, never silently matched against a *later* snapshot.
  Scoped to **the flow's own VPC plus any VPC known to be able to legally reference it** — a VPC with an
  active VPC Peering connection to the flow's VPC, or a participant VPC in the same shared-VPC (RAM)
  arrangement, per this repo's existing VPC topology data — not simply the flow's own VPC alone (SG
  references are valid across peering and shared VPCs, so a same-VPC-only scope produces a false
  `no_observed_evidence` for every legitimately cross-VPC-referenced rule) and never scoped to "any VPC"
  (which is what let an ENI in an unrelated VPC match purely by coincidentally sharing the same RFC1918
  address). An ENI that resolves outside this VPC set is `unassessable`, not treated as a non-match.
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
- historical evidence mapped using current membership only

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
the same ADR-005/ADR-007 posture analysis and BASELINE §2 register row required by the feature gate
above, applied at the IAM boundary rather than only at the flag. The host account uses its execution
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
