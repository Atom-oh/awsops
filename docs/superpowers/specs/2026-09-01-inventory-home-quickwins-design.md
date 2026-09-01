# Inventory-home quick wins — 2 gap-audit items (L126, L127)
# 인벤토리 홈 퀵윈 — 갭 감사 2건 (L126, L127)

**Status:** Batch 12, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/inventory-home-quickwins`.
**WA pillar:** Operational Excellence (fleet trend legibility).

Closes gap-audit items: L126 (series show/hide toggle chips), L127 (summary KPI bar).

## 요약 (한국어)

홈 대시보드 퀵윈 2건: 리소스 추세 차트 아래 시리즈 토글 칩(Core Resources 상위 5종 기본
표시 / Other Resources 기본 숨김, 클릭으로 show/hide — 색상은 원래 시리즈 인덱스에 고정되어
토글해도 남은 라인 색이 바뀌지 않음)과 인라인 요약 KPI 바(리소스 타입 수 · 전체 리소스 ·
7일 순증감 ± 색상 — 스냅샷 2개 미만/±2일 내 스냅샷 부재 시 0을 지어내지 않고 '—').
클라이언트 전용 — 기존 summary/trend 응답 재사용, 서버/스키마 변경 없음.

## Decisions
- `MultiLineTrend` gains opt-in `interactiveLegend` + `legendGroups` + `defaultHidden` —
  existing (non-interactive) charts keep the static legend unchanged.
- Home trend series widens from top-8 to top-12 types; Core = top 5 (visible), Other = the
  rest (default-hidden) — bounded, so re-enabling everything stays legible.
- 7d net change reuses the delta table's nearest-snapshot ±2-day tolerance on the `total`
  column; no snapshot in tolerance → '—' (honest-degrade, never a fabricated 0).

## Testing
- MultiLineTrend: grouped chips render; defaultHidden starts off; toggle both directions;
  non-interactive charts keep the static legend.
- Full `npm test` + `tsc` + build; gap-audit ticks with a batch-12 note.
