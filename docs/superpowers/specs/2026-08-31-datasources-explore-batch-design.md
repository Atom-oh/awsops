# Datasources Explore/management batch — 9 v1-parity gaps
# 데이터소스 Explore/관리 배치 — v1 패리티 갭 9건

**Status:** Approved 2026-08-31. Branch `feat/datasources-explore-batch`.
Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L84 (curated example/NL chips),
L85 (Loki log viewer), L86 (7d/30d ranges), L88 (result metadata bar), L200 (AI-generated
banner), L201 (management KPI cards), L202 (manual refresh), L204 (per-row Diagnose-with-AI),
L205 (Tempo duration bars). Deferred: L203 (per-datasource connection settings — [M], separate
connector work) and L206 (app-wide ko/en/zh i18n — [L], platform decision).

## 요약 (한국어)

Explore 콘솔과 Datasources 관리 탭의 v1 패리티 소규모 갭 9건을 한 PR로 복원한다. 전부 기존
read-only 경로 위의 프론트엔드 + 쿼리 API의 소폭 확장(범위 상한 30d, 실행시간 메타데이터)이며,
신규 테이블/Terraform/커넥터 변경 없음.

## Decisions (per item)

### L84 — Curated example-query + NL-prompt chips (all 8 kinds)
New pure module `web/lib/example-queries.ts`:
- `EXAMPLE_QUERIES: Record<string, { label: string; expr: string }[]>` — 4 curated raw
  queries per kind (prometheus, mimir: PromQL · loki: LogQL · tempo: TraceQL · clickhouse: SQL ·
  jaeger: search params · dynatrace: metricSelector · datadog: metric query). Module constants,
  no user input — same injection posture as the diag-signal catalog.
- `AI_EXAMPLES: Record<string, string[]>` — 4 natural-language prompts per kind (Korean).
ExplorePanel renders two chip rows: raw-example chips under the query box
(click → `setQuery(expr)` + immediate `run`, exactly the DiagSignalChips onPick contract) and
NL-example chips under the NL input (click → `setNl(text)` only — AI generation stays
user-initiated, never auto-runs). Chips render only when a datasource with a known kind is
selected. Distinct style from diag chips (outline vs the chips' filled) to keep the two
families visually separable.

### L85 — Dedicated Loki log stream viewer
New `web/components/datasources/LogStreamView.tsx` rendering `shape === 'logs'` results
instead of the generic DataTable: per-line mono timestamp, up to 3 colored label badges
parsed from the normalized `labels` string (`{k="v", k2="v2"}` → pairs; >3 → `+N` overflow
badge), the log line in mono, alternating row shading, `max-h-[500px] overflow-auto`, and a
header with the line count. Pure label-parsing helper `parseLokiLabels(labels: string)`
exported for unit tests. Metric-LogQL results keep the existing prom-style rendering
(normalizer already routes them to `prom()` — unaffected).

### L86 — Extended time ranges (7d / 30d)
- `ExplorePanel` `RANGE_PRESETS` gains `['7d', 604800]`, `['30d', 2592000]` — `autoStep`
  already targets ~250 points (7d→2419s, 30d→10368s steps).
- `POST /api/datasources/query` raises the `range.window` upper bound from 86400 to
  **2592000** (30d). The existing `ceil(window/step) ≤ 5000` density cap stays and remains the
  real cost/DoS guard; `step ≤ 86400` unchanged (30d/86400 = 30 points still renders).

### L88 — Query result metadata bar
- The query route measures the connector call: `const t0 = Date.now(); … invokeMcpLambdaTool …`
  and returns `{ result, metadata: { executionTimeMs, tool } }` (additive — existing consumers
  read only `result`).
- ExplorePanel captures `metadata` alongside the result and renders a status strip under the
  run row: `N행 · {executionTimeMs}ms · {queryLanguage} · {shape}` where N = rows/series count
  from the normalized result and `queryLanguage` maps kind → PromQL/LogQL/TraceQL/SQL/
  Jaeger/DQL(metricSelector)/Datadog.

### L200 — AI-generated query explanation banner
After a successful `generate()`, show a dismissible purple banner:
`AI 생성됨 — "{nl}"에서 {queryLanguage} 쿼리를 생성했습니다. 실행 전 검토하세요.`
Cleared when the user edits the query textarea manually, dismisses it, or switches instance.

### L201 — Management-view KPI cards
`DatasourcesTab` renders a `StatTile` row above the table: 총 데이터소스, connected 수, kind
종류 수, default 지정 여부(이름). Client-side rollup of the already-fetched list — no new API.
(v1 showed fixed per-kind tiles; a kind-count tile scales better with 8 kinds.)

### L202 — Manual refresh button
`DatasourcesTab` header row gains a refresh button calling the existing `load()` (list
re-fetch without page reload), disabled while loading.

### L204 — Per-row "AI로 진단" action
Each datasource row gains a link to
`/assistant?q=${encodeURIComponent(`${name} (${kind}) 데이터소스 연결 상태를 진단해줘`)}`.
`AssistantClient` (which already uses `useSearchParams`) reads `q` once at init and prefills
the composer input — **prefill only, never auto-send** (the user reviews and presses send).
Requires a small `setInput`/initial-input hook on the chat composer; if `useChat` exposes no
input setter, thread an `initialInput` prop through to `Composer` (implementation reads the
actual state owner first and follows it).

### L205 — Tempo trace duration inline bars
In `ResultView`, `shape === 'traces'` rows render `durationMs` as a proportional horizontal
bar (scaled to the max duration in the result set) next to the numeric value, replacing the
generic DataTable for traces with a small purpose-built table (DataTable has no per-cell
render hook). Non-numeric durations render as plain text (no bar), never NaN widths.

## Out of scope
- L203 per-datasource connection settings (timeout/cache TTL/ClickHouse DB) — connector-path work.
- L206 app-wide ko/en/zh i18n — platform decision; new strings here follow the existing
  Korean-literal `tt()` convention.
- No new tables, Terraform, IAM, or connector changes. The only API change is additive
  (`metadata`) plus the widened-but-still-density-capped range bound.

## Testing
- `web/lib/example-queries.test.ts` — every kind has 4 raw + 4 NL entries; exprs non-empty;
  kinds cover the 8 connector kinds.
- `web/components/datasources/LogStreamView.test.tsx` — label parsing (≤3 badges + overflow),
  line count header, empty-safe. `parseLokiLabels` unit cases (quoted values, commas in
  values, malformed input → []).
- `web/app/api/datasources/query/route.test.ts` (extend) — window 604800/2592000 accepted,
  2592001 rejected, density cap still enforced (e.g. window 2592000 + step 500 → 400);
  response carries `metadata.executionTimeMs` (number ≥ 0).
- ExplorePanel/DatasourcesTab behavior covered by component tests where the repo already has
  them (`DatasourcesTab.test.tsx` extended for KPI row + refresh; a new ExplorePanel chips
  test following DiagSignalChips.test.tsx conventions).
- Full `npm test` + `npx tsc --noEmit` + `npm run build` before PR.
