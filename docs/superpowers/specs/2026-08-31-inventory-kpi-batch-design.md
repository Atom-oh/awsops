# Inventory KPI/chart quick-win batch — 8 spec-level v1-parity gaps
# 인벤토리 KPI/차트 퀵윈 배치 — 스펙 수준 v1 패리티 갭 8건

**Status:** Approved 2026-08-31 (batch selected by owner). Branch `feat/inventory-kpi-batch`.
Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L103 (ec2 running vCPU KPI),
L100 (ebs encryption % KPI), L134 (lambda long-timeout KPI), L230 (lambda avg-memory KPI),
L109 (ecs_cluster KPI band), L107 (ecr scan-on-push column), L239 (rds total storage KPI),
L190 (cloudwatch alarm-state donut semantic colors).
Also ticks as ALREADY SHIPPED (stale audit rows, verified against current code):
L212 (ecr tag-immutability KPI — `HIGHLIGHTS.ecr` has it), L238 (rds storage-by-instance bar —
`rds.barKey` exists), L108 (ecs weighted view — covered by `ecs_cluster.barKey` Top-N running-tasks bar).

## 요약 (한국어)

인벤토리 페이지의 KPI/차트 소규모 갭 8건을 한 PR로 복원한다. 전부 이미 sync된 컬럼 위의
클라이언트 계산(`computeHighlights` kind 확장 + `HIGHLIGHTS`/spec 항목 + ecr 파생 컬럼 +
도넛 시맨틱 컬러)이며, 신규 API/테이블/Terraform 없음.

## Decisions

### New `Highlight` kinds (`web/lib/inventory-types.ts`, pure + unit-tested)
- `{ kind: 'countGt'; label; col; gt: number; tone? }` — rows where `Number(cell) > gt`
  (non-numeric cells never match). → lambda `timeout > 300` (L134).
- `{ kind: 'avg'; label; col; suffix?; }` — mean of finite numeric cells, rounded;
  rows with non-numeric cells excluded from the denominator; 0 rows → '—'. → lambda
  `memory_size` avg MB (L230).
- `{ kind: 'percent'; label; col; eq: string; }` — `count(cell==eq) / count(rows)` as
  `NN% (n/total)`; variant from the RAW ratio: every row matching → accent, ratio ≥0.8 →
  default, else danger; 0 rows → '—'. A rate that rounds to 100% without being a complete
  match displays one decimal (499/500 → '99.8%'), so a near-complete fleet never reads '100%'.
  → ebs `encrypted == 'true'` 암호화율 (L100).
- `{ kind: 'sumProductWhere'; label; cols: [string, string]; where; eq; suffix? }` —
  Σ(colA × colB) over rows matching where==eq; a row with a non-numeric factor contributes 0.
  → ec2 running vCPU = `cpu_options_core_count × cpu_options_threads_per_core` where
  `instance_state == 'running'` (L103; per-instance actual, not the type-default `vcpus`).

### HIGHLIGHTS additions
- `ec2`: + `sumProductWhere` 실행 중 총 vCPU.
- `ebs_volume`: + `percent` 암호화율.
- `lambda`: + `countGt` 타임아웃>300s (danger tone), + `avg` 평균 메모리 (' MB').
- `rds`: + `sum` 총 스토리지 (`allocated_storage`, ' GB') (L239).
- `ecs_cluster` (new entry — currently falls back to generic state tiles): `sum` 실행 태스크,
  `sum` 활성 서비스(`active_services_count`), `sum` 컨테이너 인스턴스
  (`registered_container_instances_count`), `countWhere` ACTIVE (accent) (L109).

### ECR scan-on-push column (L107)
`web/lib/inventory-derived.ts` gains an `ecr` deriver: `scan_on_push: 'Yes' | 'No'` from
`image_scanning_configuration.scan_on_push` (JSON-string tolerant, same cell semantics as
highlights). `ecr.columns` gains `{ key: 'scan_on_push', label: 'Scan on Push' }`.

### CloudWatch alarm-state donut semantic colors (L190)
`InvType` gains optional `distKey2Colors?: Record<string, string>`; the inventory page passes
it to the second donut's existing `colors` prop. `cloudwatch_alarm.distKey2Colors =
{ OK: '#01A88D', ALARM: '#D13212', INSUFFICIENT_DATA: '#9AA6B2' }` (semantic, matches the
STATUS_DOT palette). Name-cased per the synced `state_value` values (verify casing from the
sync data — countWhere uses lowercase eq with case-insensitive compare; the donut buckets use
raw values, so map both cases if needed).

### Out of scope
- L135 lambda memory histogram (needs a bucketing chart mode — separate item).
- L102/L110 500-row-cap accurate totals (page-level summary wiring — separate item).
- L251 subnets-per-VPC donut (would displace the public/private donut — needs a UX decision).

## Testing
- `web/lib/inventory-types.test.ts` (extend): each new kind — countGt (boundary: eq value not
  counted; non-numeric ignored), avg (rounding, empty '—'), percent (variants at 100/80/79,
  0-row '—'), sumProductWhere (where filter, non-numeric factor → 0); HIGHLIGHTS entries exist
  for ec2/ebs_volume/lambda/rds/ecs_cluster with the new kinds.
- `web/lib/inventory-derived.test.ts` (extend if present, else add): ecr deriver Yes/No + missing
  config → 'No'.
- Full `npm test` + `tsc` + `npm run build`; gap-audit ticks with a batch-7 note.
