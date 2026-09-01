# RDS detail metric time-series — 3 gap-audit items (L141, L142, L155)
# RDS 상세 메트릭 시계열 — 갭 감사 3건 (L141, L142, L155)

**Status:** Batch 13, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/rds-metric-trends`.
**WA pillar:** Performance Efficiency / Reliability (instance-level trend visibility).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L155 (detail-panel 1h metric
sparklines), L142 (FreeableMemory 24h trend + Avg/Max/Min), L141 (CPU 14d daily trend +
Avg/Max/Min).

## 요약 (한국어)

RDS 인스턴스 상세 패널에 v1 패리티 시계열 3종을 추가한다: 6개 메트릭(CPU/FreeableMemory/
Connections/Read·WriteIOPS/FreeStorage)의 최근 1시간 5분 단위 스파크라인(포인트 ≤2면
Avg/Max/Min 폴백), FreeableMemory 24시간(1시간 단위) 추이 + Avg/Max/Min 타일, CPU 14일
일별 추이 + Avg/Max/Min 타일. GetMetricData 2회 병렬(스파크 ~65분 윈도우 + 장기 14일
윈도우)로 수집하는 read-only 라이브 조회 — Terraform/IAM/스키마 변경 없음(기존 CloudWatch
read 권한 재사용).

## Decisions

- **Lib** `rdsInstanceTrends(instanceId, accountId?)` (`web/lib/metrics.ts`): TWO parallel
  `GetMetricData` calls — sparks (6 queries, Period 300) over their OWN ~65-minute window,
  and the long trends (FreeableMemory Period 3600 + CPUUtilization Period 86400) over a
  14-day window. `Period` sets aggregation RESOLUTION, not a window — a single 14-day
  StartTime would return ~4,000 datapoints per 5-min query (~24k/panel open) only to be
  trimmed client-side. Series are `{t, v}[]` (ISO, `ScanBy: 'TimestampAscending'`); any
  CloudWatch error degrades every series to null (the `rdsMetrics` contract). The
  route's `trends=1` path returns ONLY the trends (no `rdsMetrics` snapshot — the section
  discards it and its sibling already fetches it; the id is charset-validated like the
  sibling `?ids=` branch).
- **Route** (`/api/inventory/[type]/metrics` rds `?id=` branch): opt-in `&trends=1` returns
  `{trends}` only — existing `?id=` consumers keep today's shape/latency untouched.
- **UI** `web/components/inventory/metrics/RdsTrendsSection.tsx` (named export), mounted in
  `DetailPanel` below the existing `RdsMetricsSection`:
  - 6 per-metric 1h sparklines (tiny no-axis LineChart) — a series with ≤2 points renders the
    v1 Avg/Max/Min fallback grid instead of a misleading 2-point line; a missing series
    renders '데이터 불가'.
  - FreeableMemory 24h `AreaTrend` (GB) + Avg/Max/Min tiles.
  - CPU 14d daily `AreaTrend` (%) + Avg/Max/Min tiles.
  - One fetch (`trends=1`), one loading/error state per block group; a 200 without `trends`
    (rolling-deploy version skew) takes the error branch instead of pinning the loading state;
    never a dead panel. Axis labels render in KST; the spark field keys are a typed union
    (drift vs the lib fails to compile instead of silently rendering '데이터 불가').
  - Known parity limitation (same as the sibling RdsMetricsSection, documented in the route
    header): the CloudWatch client is host-account/fixed-region — threading account/region is
    a separate follow-up.

## Testing
- Lib: two-call construction (spark window <70min, long window ≥13d, per-query periods,
  ScanBy ascending), series mapping + 1h window filter, error degrade to nulls.
- Route: `trends=1` returns only trends with no rdsMetrics call; default `?id=` shape
  unchanged; malformed id → 400.
- Component: sparkline vs ≤2-point fallback vs missing-series '데이터 불가'; 24h/14d blocks
  with Avg/Max/Min; fetch-failure inline error.
- Full `npm test` + `tsc` + build; gap-audit ticks with a batch-13 note.
