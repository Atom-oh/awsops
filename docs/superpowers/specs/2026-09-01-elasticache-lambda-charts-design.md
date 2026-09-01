# ElastiCache detail sparklines + Lambda memory histogram — 2 gap-audit items (L118, L135)
# ElastiCache 상세 스파크라인 + Lambda 메모리 히스토그램 — 갭 감사 2건 (L118, L135)

**Status:** Batch 14, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/elasticache-lambda-charts`.
**WA pillar:** Performance Efficiency (cache/function resource visibility).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L118 (elasticache detail 1h metric
sparklines), L135 (lambda memory-allocation histogram).

## 요약 (한국어)

ElastiCache 상세 패널에 v1 패리티 1시간 스파크라인(LIVE_SPECS 공유 테이블 기반이라
OpenSearch/MSK도 함께 지원 — CPU/Engine CPU/FreeableMemory/NetworkBytesIn·Out/Connections
등 스펙별 메트릭, ≤2 포인트 Avg/Max/Min 폴백, 시리즈 부재 '데이터 불가')과 Lambda 페이지의
메모리 할당 히스토그램(memory_size 값별 함수 수, 상위 10개 숫자 정렬 — 신규 generic
`InvType.histKey`)을 추가한다. read-only GetMetricData 1회(~65분 윈도우, Period 300),
Terraform/IAM/스키마 변경 없음.

## Decisions
- **Lib** `liveResourceTrends(type, id)` — LIVE_SPECS 재사용(one bounded ~65-min call,
  Period 300, ScanBy ascending); per-metric `{label, fmt, samples|null}`; [] on error/unknown
  type. `LiveFmt` exported; the client component carries a tiny fmt twin (importing
  lib/metrics client-side would pull the AWS SDK into the bundle).
- **Route** live-metrics `?id=` branch: `trends=1` returns ONLY `{trends}` (the RDS trends=1
  contract — the latest-value grid is the sibling section's fetch); id charset-validated.
- **UI** `LiveTrendsSection` (named export) mounted below `LiveMetricsSection` for all
  LIVE_SPECS types (elasticache/opensearch/msk) — RdsTrendsSection's exact degrade contract
  (≤2-point fallback, null-series '데이터 불가', 200-without-trends → error branch).
- **L135** generic `InvType.histKey` → the page computes counts per distinct numeric value
  (top 10 by count, then numerically sorted) and renders a second `BarDistribution` beside
  the Top-N bar; `lambda.histKey = { col: 'memory_size', suffix: ' MB' }`.

## Testing
- Lib: bounded window/period/labels, null-on-empty series, [] on unknown type + deny.
- Route: trends=1 returns only trends (no liveResourceMetrics call); malformed id → 400.
- Component: sparkline/fallback/null-series; skew → error branch; empty trends → 데이터 불가.
- Full `npm test` + `tsc` + build; gap-audit ticks with a batch-14 note.

## Round-2 corrections (review-driven)

- **CacheHitRate is a 0–1 RATIO** (per the existing `ElasticacheNodeMetrics.hitPctOf`
  precedent: `hr <= 1 ? hr*100 : hr`) — a plain `pct` fmt rendered 0.92 as "0.9%". New
  `ratioPct` fmt in both the server `fmtLive` and the client `fmtValue` twin.
- **OpenSearch `ClientId` must be the OWNING account** — the hardcoded host id made every
  member-account domain query return empty series while the diff claimed cross-account support.
  `LiveMetricSpec.dims` widened to `(id, accountId?)`; both `liveResourceMetrics` and
  `liveResourceTrends` pass the account through.
- **Region threaded alongside account** — account without region half-opens the scope (a
  member cluster outside the deployment region reads '데이터 불가', or a same-named
  default-region cluster charts the WRONG resource). `liveResourceTrends(type, id, account?,
  region?)`; route validates `region` (AWS-region shape `/^[a-z]{2,4}(-[a-z]+)+-\d$/` → 400,
  the sg-rules.ts form — the string reaches SDK client construction); LiveTrendsSection sends
  `&region=`; DetailPanel passes `data.region` (mirrors EbsRelatedSection).

## Round-3 corrections (review-driven)

- **The latest-value grid is account/region-scoped too** — round 2 scoped only the new trends
  path, leaving the pre-existing `LiveMetricsSection` grid host-pinned while the CHANGELOG
  claimed member-account domains "return data". Now the route's whole `?id=` branch validates
  `account`/`region` once and passes both to `liveResourceMetrics(type, id, account?, region?)`
  as well; `LiveMetricsSection` sends `&account=&region=` from `data.account_id`/`data.region`
  — making the CHANGELOG bullet true end-to-end instead of narrowing it.
- **Rules-of-hooks fix** — the `histData` `useMemo` moved above the page's `if (!spec)` early
  return (the diff had introduced the component's first conditional hook; no ESLint here to
  catch regressions).
- Audit note: v2 places the Lambda memory histogram beside the Top-N memory bar (v1 sat it
  alongside the runtime pie) — presentational deviation, recorded on the L135 tick.
- **CHANGELOG Fixed bullets (EN/KO)** for the user-visible FreeStorageSpace ~1e6× display fix
  + CacheHitRate ratio fix + member-account ClientId fix.
