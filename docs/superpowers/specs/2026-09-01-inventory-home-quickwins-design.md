# Inventory-home quick wins — 2 gap-audit items (L126, L127)
# 인벤토리 홈 퀵윈 — 갭 감사 2건 (L126, L127)

**Status:** Batch 12, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/inventory-home-quickwins`.
**WA pillar:** Operational Excellence (fleet trend legibility).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L126 (series show/hide toggle
chips), L127 (summary KPI bar).

## 요약 (한국어)

홈 대시보드 퀵윈 2건: 리소스 추세 차트 아래 시리즈 토글 칩(Core Resources 상위 5종 기본
표시 / Other Resources 기본 숨김, 클릭으로 show/hide — 색상은 원래 시리즈 인덱스에 고정되어
토글해도 남은 라인 색이 바뀌지 않음)과 인라인 요약 KPI 바(리소스 타입 수 · 전체 리소스 ·
7일 순증감 ± 색상 — 스냅샷 2개 미만/±2일 내 스냅샷 부재 시 0을 지어내지 않고 '—').
클라이언트 전용 — 기존 summary/trend 응답 재사용, 서버/스키마 변경 없음.

## Decisions
- `MultiLineTrend` gains opt-in `interactiveLegend` + `legendGroups` + `defaultHidden` —
  existing (non-interactive) charts keep the static legend unchanged. Chips are
  `type="button"`, ungrouped series keys surface in an extra unlabeled row (never
  un-toggleable), and the home chart is `key`-ed on the series signature so a period-driven
  type re-rank resets the hidden state instead of silently misapplying it.
- Home trend series stays at top 8 (the chart palette has exactly 8 hues — more would
  duplicate line/chip colors); Core = top 5 (visible), Other = the remaining 3
  (default-hidden). The default view therefore draws 5 lines where it previously drew 8 —
  disclosed in the CHANGELOG.
- 7d net change lives in `web/lib/trend-utils.ts` (`nearestSnapshot` + `netChange`, pure and
  unit-tested — Next pages can't export helpers): date-normalized ±2 CALENDAR days; null →
  '—' when <2 snapshots, no baseline in tolerance, the baseline IS the latest point (stale-
  sync self-diff would fabricate 0), the LATEST point itself is >2 days old (a short diff
  labeled "7d"), or the account/region scope is narrowed (the trend endpoint is
  `account_id='self'`-fixed with no region dimension — open audit L124). COVERAGE PARITY:
  the diff sums only types snapshotted on BOTH days — the snapshot writer emits one row per
  type on its own success path, so a mid-fan-out/partially-failed day drops types from
  `total`, and a raw total-diff would render that as a large confident negative (a sync
  artifact, worse than a fabricated 0).
- The trend route now ranks `types` by the LATEST day's counts (fallback last-seen) — the
  previous all-rows last-write-wins let a dead type hold a Core slot on a stale count while a
  live series landed default-hidden.
- Known label caveat: 리소스 타입 counts currently-nonempty `inventory_resources` types
  (including derived catalog types), which is a superset of the snapshot series the adjacent
  chart tracks — the two numbers may not reconcile exactly; accepted as-is.

## Testing
- MultiLineTrend: grouped chips render; defaultHidden starts off; toggle both directions;
  non-interactive charts keep the static legend.
- Full `npm test` + `tsc` + build; gap-audit ticks with a batch-12 note.
