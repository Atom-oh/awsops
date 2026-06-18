# Plan — Schema-aware PromQL generation + Explore range UX

Spec: `docs/superpowers/specs/2026-06-18-prom-schema-explore-ux-design.md`
Branch: `consensus/prom-schema-explore-ux` (worktree off `feat/v2-architecture-design`)

TDD throughout: write the failing test first, minimal code to green, then refactor.
One commit per task, explicit paths only. Read-only; no AWS-resource mutation.

**Test commands**
- web: `npm --prefix web run test` (vitest) — scoped: `npm --prefix web exec vitest run <file>`
- agent: `python3 -m pytest agent/lambda/test_prometheus_mcp.py agent/lambda/test_mimir_mcp.py -q`
- structure: `bash tests/run-all.sh`

---

### Task 1: Connector `prometheus_metric_meta` tool

**Files:**
- Modify: `agent/lambda/prometheus_mcp.py`
- Test: `agent/lambda/test_prometheus_mcp.py`

- [ ] Write failing test: `prometheus_metric_meta({"metrics":[...]})` calls `/api/v1/metadata`
      once and `/api/v1/labels?match[]={__name__="<m>"}` per metric (mock `_get`); returns
      `{ "<m>": {"type": "<t|null>", "labels": [names...]} }`, label **names only**, bounded to
      ≤12 metrics, a per-metric `_ApiError` is skipped (not fatal), empty `metrics` → `{}`.
- [ ] Implement `prometheus_metric_meta(args)`: parse+cap metrics; one metadata fetch → type map;
      per-metric labels via `match[]` selector; assemble; tolerate per-metric errors.
- [ ] Register `"prometheus_metric_meta"` in `_TOOLS`.
- [ ] Green; refactor any shared metadata/label parsing into a small helper.

### Task 2: Connector `mimir_metric_meta` tool (mirror)

**Files:**
- Modify: `agent/lambda/mimir_mcp.py`
- Test: `agent/lambda/test_mimir_mcp.py`

- [ ] Write failing test mirroring Task 1 against the Mimir connector (same Prometheus HTTP API).
- [ ] Implement `mimir_metric_meta` (reuse the Prometheus shape; share a helper if the connectors
      already share one, else mirror) and register in the Mimir `_TOOLS`.
- [ ] Green.

### Task 3: Schema `metricMeta` — render, prioritize, and pure merge/select helpers

**Files:**
- Modify: `web/lib/datasource-schema.ts`
- Test: `web/lib/datasource-schema.test.ts`

- [ ] Failing test for `renderSchemaForPrompt`: when `metricMeta` present, emit
      `metric{label,label,…} [type]` lines (relevant-first), drop the redundant global `labels:`
      line; when absent, behaviour is unchanged (flat `metrics:`/`labels:` fallback); bounds,
      per-line clamp, and explicit truncation disclosure still hold with enriched metrics.
- [ ] Failing test for `prioritizeSchemaForQuery`: enriched (metricMeta) metrics relevant to the
      NL float to the front so they survive the render cap; non-mutating when nothing matches.
- [ ] Failing test for pure helpers `mergeMetricMeta(schema, metaMap)` (additive, size-safe) and
      `selectMetricsForMeta(prioritizedSchema, k)` (top-K NL-scored metric names, ≤k, score>0 only;
      empty when nothing scored).
- [ ] Implement the renderer branch, prioritizer handling, and the two pure helpers; green; refactor.

### Task 4: Generate route — lazy meta fetch + cache-back wiring

**Files:**
- Modify: `web/app/api/datasources/generate/route.ts`
- Test: `web/app/api/datasources/generate/route.test.ts`

- [ ] Failing test: for `kind ∈ {prometheus,mimir}` with a cached schema, the route selects the
      NL-relevant top-K metrics, invokes `${kind}_metric_meta` once (mock connector), merges the
      returned meta, writes back via the cache, and the rendered schema block contains
      `metric{labels}`; metrics already having `metricMeta` are NOT re-fetched.
- [ ] Failing test: meta fetch failure / no endpoint / non-prom-mimir kind → falls back to current
      behaviour, generation still proceeds (no throw).
- [ ] Implement the lazy branch in `resolveSchemaBlock` using the Task 3 helpers; keep connector
      invoke + cache write in the route, selection/merge in the pure helpers; green; refactor.

### Task 5: Querygen prompt — PromQL aggregation rule

**Files:**
- Modify: `web/lib/datasource-querygen.ts`
- Test: `web/lib/datasource-querygen.test.ts`

- [ ] Failing test: `buildQueryGenSystem('PromQL', …)` includes the topk/`sum by`/`rate`/
      `histogram_quantile` + "labels only from the metric's listed labels, never invent" rule;
      `buildQueryGenSystem('read-only SQL', …)` does NOT include it (no cross-kind leakage).
- [ ] Implement the PromQL-gated instruction; green.

### Task 6: Query route — `{window, step}` range args + validation + back-compat

**Files:**
- Modify: `web/app/api/datasources/query/route.ts`
- Test: `web/app/api/datasources/query/route.test.ts`

- [ ] Failing test: body `range:{window,step}` → range tool invoked with `start`/`step` args;
      window bounds (1..86400s) and step bounds (≥1) validated → 400 on violation; absent range →
      instant tool; legacy `range:true` → range tool with the 1h default (back-compat).
- [ ] Implement range-arg parse+validate+pass-through; green.

### Task 7: ExplorePanel — range dropdown + auto re-run

**Files:**
- Modify: `web/components/datasources/ExplorePanel.tsx`
- Test: `web/components/datasources/ExplorePanel.test.tsx`

- [ ] Failing test: range-capable kind renders a `범위` dropdown `Instant|5m|15m|1h|6h|24h`
      (default Instant); selecting a window posts `{window, step}` with auto step
      `max(1, round(windowSec/250))`; changing the dropdown re-runs when a query is present;
      Instant posts no range; non-range kinds (tempo/clickhouse) show no control.
- [ ] Implement: replace the `range` checkbox with the select; compute step; auto-rerun effect
      guarded on a non-empty query; green; refactor.

### Task 8: Instant ranked bar chart (reuse `HBarList`)

**Files:**
- Modify: `web/components/datasources/ExplorePanel.tsx`
- Test: `web/components/datasources/ExplorePanel.test.tsx`
- Modify: `web/components/charts/HBarList.tsx`

- [ ] Failing test: an instant result (`shape:'table'`) with ≤30 numeric `value` rows renders a
      ranked horizontal bar (HBarList) above the table (desc by value); >30 rows → table only;
      a range result (`shape:'series'`) still renders AreaTrend (unchanged).
- [ ] Implement the `ResultView` instant-ranking branch deriving `{label,value}` from rows; adapt
      `HBarList` props only if required; green; refactor.
