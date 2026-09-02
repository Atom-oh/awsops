# Detail drill-down 3: Bedrock per-model charts, ElastiCache SG rules, EBS live IOPS — 3 gap-audit items (L184, L223, L233)

**Status:** Batch 33, 2026-09-02 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch33`.
**WA pillar:** Operational Excellence / Performance Efficiency (drill-down completeness).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L184 (Bedrock per-model time-series
charts), L223 (ElastiCache SG inbound-rule drill-down), L233 (EBS measured Read IOPS).

## Decisions
- **L184** — `bedrockModelMetrics` now PRESERVES per-model `{t, v}` series (invocations, and
  input+output tokens merged per timestamp) instead of discarding timestamps into the fleet
  sum; `BedrockModelMetric` gains `invSeries`/`tokenSeries` (optional on the page type — an
  older cached response may omit them). The bedrock page renders two `AreaTrend` charts as
  the DetailPanel's `children` for the picked model, over the SAME selected range as the rest
  of the page; an empty series renders an honest '시계열 데이터 없음' line, never a
  fabricated flat chart. Same single GetMetricData call — no extra CloudWatch traffic.
- **L223** — DetailPanel's RDS-only SG-id extraction generalizes to a shared `sgIdList`
  helper (adds the `SecurityGroupId`/`security_group_id` key shape ElastiCache rows carry),
  and `resourceType === 'elasticache'` chains `data.security_groups` into the SAME
  `RdsSgRulesSection` + `/api/inventory/security_group/inbound` route the RDS drill-down
  already uses — synced-inventory only (no live AWS call), unsynced SGs read 'not synced'.
- **L233** — `LIVE_SPECS` gains `ebs_volume` (namespace AWS/EBS, VolumeId dim): Read/Write
  IOPS from `VolumeRead/WriteOps` period Sums with a new `perSecond` def option — BOTH call
  sites divide by their own Period (latest grid 3600s, spark trends 300s) so the new `iops`
  format renders true ops/sec — plus Queue Length and Burst Balance. `ebs_volume` joins
  DetailPanel's LIVE_METRIC_TYPES, so the volume detail gets the latest-value grid + the
  shared 1-hour 5-minute sparkline contract. Deliberate deviation from v1's 24-hour line
  chart: every live-metric type shares the same 1h spark window (the L118 precedent) —
  disclosed in the audit note. The volume-id shape passes the route's existing id validation;
  the generic `hasLiveMetrics` branch serves it with zero route changes.

## Testing
- bedrockModelMetrics: per-model invSeries/tokenSeries preserved and timestamp-merged.
- ebs_volume live spec: latest grid ÷3600 → '2 IOPS'; spark samples ÷300.
- Existing RdsSgRulesSection/route tests keep covering the shared drill-down path.
- Full `npm test` + `tsc` + build + `pytest scripts/v2/{workers,steampipe}`; gap-audit ticks
  with a batch-33 note; CHANGELOG EN/KO; docs-site guides in 4 locales (bedrock row-click,
  elasticache SG drill-down source, ebs live metrics).

## Round-1 corrections (review-driven)

- **mergeBedrock merges the per-model series across accounts (the gate MAJOR)** — the
  All-accounts merge copied the first account's model object and summed only scalars, so the
  detail charts silently showed ONE account while the surrounding totals summed all (the
  L184 item's own '멀티계정 fan-out' half). `mergeBedrock` moved to `lib/bedrock-merge.ts`
  (a Next.js page may not export helpers) with timestamp-merge for invSeries/tokenSeries,
  unit-tested across two accounts; lib module count declaration re-verified (the stale 118 →
  measured 134).
- The client sparkline formatter gains the `iops` case (EBS Avg/Max/Min no longer render
  unitless integer-rounded values) and `VolumeQueueLength` uses a new `dec1` format —
  fractional queue-length averages must not integer-round to 0.

## Round-2 corrections (review-driven)

- **Complete-bucket selection for perSecond metrics (the gate MAJOR)** — the latest grid
  divided the still-filling newest hour bucket by 3600 (systematic understatement — the
  partial bucket is the value ALWAYS displayed), and the spark's trailing partial 5-min
  bucket ÷300 ended every chart in a fake dip. The latest grid now picks the newest bucket
  whose end is past (only-partial data reads '—'), the spark drops the incomplete trailing
  bucket, and tests exercise the partial/complete relationship rather than encoding ÷N.
- **Model selection keyed on modelId (the gate MAJOR)** — getModelLabel collides across
  regional id variants and the merge keys rows by modelId; row clicks now set modelId (label
  kept for display/title only).
- **L233 audit note disclosed the residue (the L5 MAJOR)** — v1's list-table latest-IOPS +
  measured-at columns and row-click Avg/Max/Min tiles are NOT delivered (detail-panel grid +
  sparkline instead; Avg/Max/Min exists only in the ≤2-sample fallback).
- Minors: inventory-detail's security_groups reader learns the SecurityGroupId shape (the
  same cluster's own SG row no longer falls back to raw JSON); iops/dec1 gain thousands
  grouping; TERMS en aligned to 'Token Usage (input+output)'; docs add the BurstBalance
  gp2/st1/sc1 qualifier and EBS joins the why-awsops inline-CloudWatch list (4 locales).

## Round-3 corrections (review-driven)

- **perSecond metrics query at Period 300 in the latest grid (the freshness MAJOR)** — the
  round-2 complete-HOURLY-bucket fix traded understatement for staleness (a headline up to
  1–2h old above a 5-minute sparkline, and '—' on any volume younger than the first complete
  hour). The latest value now derives from the newest complete 5-minute bucket ÷300 (fresh
  ≤5min); non-perSecond metrics keep Period 3600. Tests pin both the bucket selection and the
  per-metric Period split.
- **The per-model token chart gets its own TERMS key (the L5 MAJOR)** — round-2's EN rename
  of the SHARED key also retitled the fleet chart, contradicting the EN guide's untouched
  "Token trend" lines and colliding the two chart titles in every locale. The fleet key's EN
  is aligned to the documented fleet label ('Token trend (input + output)'); the detail chart
  uses the new '모델별 토큰 추이 (입력+출력)' key ('Token Usage (input+output)'), and the
  ko/zh/ja guide sentences quote the new title.
- Minors: single-point per-model series falls to the honest no-data line (> 1 guards —
  AreaTrend draws nothing for a singleton with dot={false}); the ebs_volume detail id pins
  the vol- shape like the sibling fleet branch; merge tests moved to
  lib/bedrock-merge.test.ts (colocation convention); stale "ElastiCache/OpenSearch/MSK"
  comments widened to include EBS.
