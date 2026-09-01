# Small v1-parity sweep — 5 gap-audit items (L62, L68, L110, L137, L182)
# 소규모 v1 패리티 스윕 — 갭 감사 5건 (L62, L68, L110, L137, L182)

**Status:** Batch 10, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/small-parity-sweep`.
**WA pillar:** Operational Excellence (event forensics, alarm triage, accurate fleet counts).

## 요약 (한국어)

서로 독립적인 소형 패리티 5건: CloudTrail 이벤트 상세 드릴다운(raw JSON 포함), CloudWatch
알람 worst-first 기본 정렬, 500행 캡과 무관한 정확한 '총 N' 타일(summary byType 기반),
Lambda 값 포맷(last_modified 날짜, null runtime → 'custom'), Bedrock '사용 모델' KPI 타일.
서버 측 변경은 CloudTrail events 라우트의 응답 필드 확장(read-only, 동일 API 호출)뿐.

## Decisions

### L62 — CloudTrail event detail drill-down
- Route (`app/api/inventory/cloudtrail/events/route.ts`): the SDK response's
  `CloudTrailEvent` JSON is already parsed for `readOnly` and thrown away — keep the parse and
  additionally map `eventId`, `awsRegion`, `sourceIPAddress`, `userAgent`, `errorCode`, the
  full `resources` list (today only `Resources[0]` survives), and `raw` (the parsed event
  object). Same `LookupEvents` call — no new AWS surface.
- UI (`CloudTrailEvents.tsx`): rows become clickable → the existing `DetailPanel` (no spec →
  flat key list, the same renderer inventory JSONB nests use) with the event fields + the raw
  event object. Close on ×/overlay/Escape comes free.

### L68 — CloudWatch worst-first default ordering
- `InvType` gains optional `worstFirst?: { col: string; rank: Record<string, number>;
  tieBreak?: string }` — data-only spec, applied by the page BEFORE `DataTable` so it is the
  null-sort default order; a user's own column-header sort still overrides it.
- `cloudwatch_alarm.worstFirst = { col: 'state_value', rank: { ALARM: 0, INSUFFICIENT_DATA: 1,
  OK: 2 }, tieBreak: 'state_updated_timestamp' }` (tieBreak sorts desc — newest state change
  first; unknown values rank after known ones, never hidden).

### L110 — accurate total tile past the 500-row cap
- The page fetches `/api/inventory/summary?{scope}` once per type/scope and reads
  `byType[type].count` (the true DB count). When `allRows.length >= ROW_LIMIT`, the '총 N'
  tile, the PageHeader subtitle, `Filters.totalCount`, and `RiskHero.total` use
  `max(summaryCount, allRows.length)`; below the cap the row count is already exact and the
  summary fetch result is unused. Summary failure degrades silently to the row count (what
  ships today). KPI/donut/facet numbers stay sample-based — that is L102's separate, still-open
  scope; this closes only the total-count tile lie.

### L137 — Lambda value formatting
- New `lambda` deriver (`inventory-derived.ts`): `runtime: r.runtime ?? 'custom'` (v1's
  COALESCE — covers container-image functions; overriding the raw column makes the table,
  runtime donut, facet, and detail panel all agree) and `last_modified: dateH(...)` fallback
  to the raw string. `deprecatedRuntime`/`distinct` highlights are unaffected ('custom' is not
  an EOL runtime; distinct counts it as its own kind, as v1 did).

### L182 — Bedrock 'Models Used' KPI
- `app/bedrock/page.tsx` KPI band gains a `사용 모델` StatTile (`models.length` — the
  distinct-model count for the selected range), grid bumped to fit 8 tiles.

## Testing
- CloudTrail route: mapping test (eventId/raw/resources list; malformed CloudTrailEvent JSON →
  row still renders with raw absent). Component: row click opens the panel with the raw block.
- worstFirst: unit test on the page-level sorter (ALARM first, tieBreak desc, unknown last);
  cloudwatch_alarm spec carries the field (synced-column validation extended if needed).
- Totals: tile/subtitle use the summary count only at the cap; summary failure → row count.
- Lambda deriver: null/absent runtime → 'custom'; date formatting; raw fallback.
- Bedrock: models.length tile renders.
- Full `npm test` + `tsc` + build + pytest; gap-audit ticks with a batch-10 note.
