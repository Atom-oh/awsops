# Small v1-parity sweep — 5 gap-audit items (L62, L68, L110, L137, L182)
# 소규모 v1 패리티 스윕 — 갭 감사 5건 (L62, L68, L110, L137, L182)

**Status:** Batch 10, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/small-parity-sweep`.
**WA pillar:** Operational Excellence (event forensics, alarm triage, accurate fleet counts).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L62 (CloudTrail event drill-down),
L68 (CloudWatch worst-first ordering), L110 (accurate totals past the row cap), L137 (Lambda
value formatting), L182 (Bedrock Models-Used KPI).

## 요약 (한국어)

서로 독립적인 소형 패리티 5건: CloudTrail 이벤트 상세 드릴다운(raw JSON 포함), CloudWatch
알람 worst-first 기본 정렬, 500행 캡과 무관한 정확한 '총 N' 타일(summary byType 기반),
Lambda 값 포맷(last_modified 날짜, null runtime → 'custom'), Bedrock '사용 모델' KPI 타일.
서버 측 변경은 CloudTrail events 라우트의 응답 필드 확장(read-only, 동일 API 호출),
summary 라우트의 리전 스코프 반영(홈 대시보드 카운트도 리전 축소를 따라감 — 의도된 정합화),
rows 라우트의 worst-first ORDER BY(캡 이전 정렬)이다.

## Decisions

### L62 — CloudTrail event detail drill-down
- Route (`app/api/inventory/cloudtrail/events/route.ts`): the SDK response's
  `CloudTrailEvent` JSON is already parsed for `readOnly` and thrown away — keep the parse and
  additionally map `eventId`, `awsRegion`, `sourceIPAddress`, `userAgent`, `errorCode`,
  `accessKeyId` (a first-class Event field, v1 parity), the full `resources` list (today only
  `Resources[0]` survives), and `raw` — PROJECTED through a field allowlist (forensic call
  detail stays; `userIdentity` is reduced to identity names) with credential-FAMILY keys
  inside `requestParameters`/`responseElements` recursively masked by a normalized deny-list
  (separator-insensitive: x-api-key / access_key / accessKeyId all hit; sts credentials,
  iam accessKey, lambda environment, userData, keyMaterial, authParameters). This is
  defense-in-depth ATOP CloudTrail's own sensitive-field masking — a deny-list cannot prove
  completeness, and the docs say so. Because it cannot, the forensic block (`raw` +
  `accessKeyId`) is ADMIN-ONLY (matching the ADMIN_ONLY_TYPES identity-data precedent);
  non-admins keep the flat Event fields. Same `LookupEvents` call — no new AWS surface.
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
- The SAME spec drives a server-side ORDER BY in `readResources` BEFORE the row LIMIT — a
  client-only re-sort would reorder whichever 500 rows survived the near-uniform captured_at
  cut, silently excluding firing alarms in >500-alarm fleets (v1 sorted in SQL). Identifiers
  are charset-validated before inlining even though the spec is trusted code.
- Accepted deviations: invalid region tokens in the summary route are silently DROPPED
  (matching regionWhereClause's narrow-on-invalid direction) rather than 400ing as the
  2026-06-26 scope-selector spec once suggested; L137 ships one UTC `dateH` format instead of
  v1's locale-dependent `toLocaleDateString()`/`toLocaleString()` split (consistent with every
  other deriver in the file).

### L110 — accurate total tile past the 500-row cap
- The summary route now honors the SAME `regions`/`includeGlobal` contract the rows route
  applies (strictly validated inline `regionCond`, mirroring its `accountCond`) — otherwise a
  region-narrowed page would compare region-filtered rows against an all-region count.
- The page fetches `/api/inventory/summary?{scope}` only once the 500-row cap is actually hit
  (it is the heaviest inventory aggregation; refetched after an on-demand sync) and reads
  `byType[type].count`. At the cap the '총 N' tile, PageHeader subtitle, `Filters.totalCount`,
  and `RiskHero.total` use `max(summaryCount, allRows.length)`; below the cap the row count is
  already exact. Summary failure degrades silently to the row count (what ships today).
- `RiskHero` splits the props: `total` (fleet count, `+` only when it is still a lower bound)
  vs `sampled` (rows actually scanned — drives the 표본 caption), so an exact total is never
  labeled as the sample size. KPI/donut/facet numbers stay sample-based — that is L102's
  separate, still-open scope; this closes only the total-count lie.

### L137 — Lambda value formatting
- New `lambda` deriver (`inventory-derived.ts`): `runtime: r.runtime ?? 'custom'` (v1's
  COALESCE — covers container-image functions; overriding the raw column makes the table,
  runtime donut, facet, and detail panel all agree) and `last_modified: dateH(...)` fallback
  to the raw string. `deprecatedRuntime`/`distinct` highlights are unaffected ('custom' is not
  an EOL runtime; distinct counts it as its own kind, as v1 did).

### L182 — Bedrock 'Models Used' KPI
- `app/bedrock/page.tsx` KPI band gains a `사용 모델` StatTile counting only models with
  `invocations > 0` in the range (ListMetrics enumerates ~2 weeks of metric existence, so idle
  models return 0-invocation rows and must not count; models last used >2 weeks ago fall out of
  ListMetrics entirely — a known window caveat for the 30d range, hinted on the tile). Two
  further inherited base-pipeline truncations (unpaginated ListMetrics; the 500-query
  GetMetricData slice ≈62 models) can undercount very large fleets — pre-existing behavior the
  tile now makes visible; pagination is a separate follow-up. Grid bumped to 8 tiles.

## Testing (as shipped)
- CloudTrail route: drill-down mapping, all-resources list, userIdentity projection (first-
  class accessKeyId, no credential/session detail in raw), malformed-JSON degrade, write
  filter. Component: row click opens the panel with the raw block; legacy payloads don't crash.
- worstFirst: rank order / unknown-last / tieBreak desc / no input mutation / spec presence
  (case-insensitive rank; numeric tieBreak compare matching DataTable).
- Summary route: region/includeGlobal contract (narrowed set, global folding, explicit-empty →
  FALSE, malformed-token rejection) — this is the totals-at-cap correctness test surface.
- Lambda deriver: null/absent runtime → 'custom'; date formatting; raw passthrough
  (inventory-derived.test.ts).
- CloudTrail scrub: sts credentials / lambda environment / userData fixtures — values never in
  the serialized raw, presence markers survive.
- The Bedrock tile itself has no page-level test (no page test infra exists for bedrock) —
  the invoked-only filter is a one-line expression asserted by review + typecheck.
- Full `npm test` + `tsc` + build + pytest; gap-audit ticks with a batch-10 note.
