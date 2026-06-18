# Schema-aware PromQL generation + Explore range UX — Design

- **Date**: 2026-06-18
- **Branch (work)**: `consensus/prom-schema-explore-ux` (worktree off `feat/v2-architecture-design`)
- **Status**: Approved design (brainstorming) → consensus pipeline
- **Scope**: v2 datasource Explore (Prometheus/Mimir NL→query + query console UX). Read-only.

## Problem

Two related gaps surfaced while reviewing the auto-generated Prometheus query
`topk(20, rate(container_cpu_usage_seconds_total[5m]))`:

1. **NL→query is not schema-aware at the LABEL level.** The connector schema introspect
   (`agent/lambda/prometheus_mcp.py::prometheus_schema`) stores only a flat list of metric
   **names** + a flat **global** label list (`/api/v1/labels`, union across ALL metrics). There
   is no metric→label mapping and no metric type. So the model produces `sum by (...)` (and
   decides `rate()` vs raw) from PromQL training priors, not from the connected Prometheus's
   actual schema. This is correct for well-known cadvisor metrics and **wrong** for custom
   metrics / recording rules / cluster-specific relabels (`node` vs `instance`, `pod` vs
   `pod_name`, presence of `cluster`). It is the same failure class as commit `c16f2cd`
   (metric names not reaching the prompt), one level deeper (labels).

2. **Explore "시간 범위 (range)" checkbox is opaque and buggy.**
   - Toggling the checkbox does **not** re-run the query (`run()` reads `range` only on the
     "실행" click; the checkbox `onChange` only sets state) → looks like nothing happens.
   - OFF = instant (`/api/v1/query`) → vector → `shape:'table'` → **table only**; ON = range
     (`/api/v1/query_range`, hardcoded `start=now-3600`, `step=60`) → matrix → `shape:'series'`
     → **chart**. Users discover it as a "chart on/off" toggle, the wrong mental model.
   - The range window is hardcoded 1h/step60s with no UI and is decoupled from the rate window.

## Goals

- The model builds `sum by (<labels>)` and chooses `rate()`/`histogram_quantile()` from the
  **introspected schema of the specific metric**, not from priors.
- The Explore query-type control is self-explanatory (instant vs time-range), re-runs on
  change, and gives a useful visualization in both modes.

## Non-goals (YAGNI)

- No change to `topk`-in-range server semantics (the flicker is inherent to range topk;
  default Instant + an instant-preferring prompt covers the common case).
- No label **values** introspection (cardinality bomb) — label **names** only.
- No new datasource kinds; Loki/Tempo/ClickHouse unaffected.
- No autonomous/mutating behavior — strictly read-only (ADR-041 constraint holds).

---

## Part 1 — Lazy per-metric label/type introspection (schema → AI)

### Data shape

Extend the cached Prometheus/Mimir schema JSON (Aurora `datasource_schemas.schema`) with an
optional `metricMeta` map, additive and backward-compatible:

```jsonc
{
  "version": "2.48.0",
  "metrics": ["container_cpu_usage_seconds_total", "kube_pod_info", ...],   // unchanged
  "labels":  ["container", "pod", "namespace", ...],                        // unchanged (fallback)
  "metricMeta": {                                                           // NEW, optional
    "container_cpu_usage_seconds_total": { "type": "counter", "labels": ["container","pod","namespace","node"] },
    "kube_pod_info": { "type": "gauge", "labels": ["namespace","pod","node"] }
  }
}
```

### New connector tool — `prometheus_metric_meta` (+ `mimir_metric_meta`)

`agent/lambda/prometheus_mcp.py` (and the Mimir connector, same shape). Input: `{ metrics: [name,...] }`
(bounded, ≤ a small cap e.g. 12). Behavior, all **GET, read-only**:

- `/api/v1/metadata` (ONE call) → `{ name: type }` for every metric in scope (counter/gauge/histogram/summary).
- For each requested metric: `/api/v1/labels?match[]={__name__="<metric>"}` → label **names** for that metric.
- Returns `{ "<metric>": { "type": "<type|null>", "labels": ["...",...] }, ... }`.

The K Prometheus round-trips happen **inside the Lambda** so the BFF makes a single invoke.
Label names only; bounded; best-effort per metric (a metric that errors → omitted, not fatal).
Add the tool to the connector `_TOOLS` dispatch. Read-only by construction (HTTP query API only).

### Generate route wiring (lazy + cache-back) — `web/app/api/datasources/generate/route.ts`

In `resolveSchemaBlock`, for `kind ∈ {prometheus, mimir}`:

1. Load cached schema (as today) and run `prioritizeSchemaForQuery(schema, nl)`.
2. Select the **top-K (≤8)** metrics whose NL-relevance score > 0 (reuse the prioritized order;
   if nothing scored, skip the meta fetch entirely → behaves exactly like today).
3. For metrics in that set **missing** `metricMeta`, invoke `${kind}_metric_meta` (one connector
   call) — only when an instance id + endpoint is available (SSRF-guarded, same as the on-demand
   schema introspect path).
4. Merge results into the schema object's `metricMeta` and **write back** via
   `cacheSchemaBestEffort` (self-heal — subsequent generates reuse the cache).
5. Render with the enriched schema.

All best-effort: any failure (no endpoint, connector error, timeout) falls back to today's
behavior (flat lists, generation proceeds). `maxDuration = 60` already on the route; one extra
invoke is within budget.

### Renderer — `web/lib/datasource-schema.ts::renderSchemaForPrompt`

When `metricMeta` is present, render per-metric lines instead of the two flat lists:

```
container_cpu_usage_seconds_total{container,pod,namespace,node} [counter]
kube_pod_info{namespace,pod,node} [gauge]
```

- Bounded as today (metric cap, per-line char clamp, total budget, explicit truncation disclosure).
- Metrics **without** `metricMeta` still render as bare names; the global `labels:` line is kept
  as a fallback only when `metricMeta` is absent/empty (avoid redundant noise when present).
- `prioritizeSchemaForQuery` must also reorder by `metricMeta` keys so relevant enriched metrics
  survive the cap (extend it to treat `metricMeta` entries, or keep ordering driven by `metrics`).

### Prompt — `web/lib/datasource-querygen.ts::buildQueryGenSystem`

Add a **PromQL-only** instruction (gated on `lang === 'PromQL'`), minimal to avoid regressions:

> When the request asks for "top N" of pods/containers/nodes/etc. over a window, prefer
> `topk(N, sum by (<grouping labels>) (rate(<counter metric>[<window>])))`. Choose grouping
> labels ONLY from the metric's listed labels (the `{...}` set). Use `rate()` only on counters;
> for histograms use `histogram_quantile(...)`. Never invent label or metric names.

### Tests

- `web/lib/datasource-schema.test.ts`: `metricMeta` → `metric{labels} [type]` lines; absent →
  flat fallback unchanged; bounds/truncation with enriched metrics; `prioritizeSchemaForQuery`
  keeps enriched-relevant metrics.
- New pure helper test: merge fetched meta into schema + top-K selection from prioritized order.
- `web/app/api/datasources/generate/route.test.ts`: lazy meta path (mock connector returns meta)
  → schema block contains `metric{labels}`; meta-fetch failure → falls back, still generates;
  cache-back invoked.
- `agent/lambda/test_prometheus_mcp.py`: new `prometheus_metric_meta` — metadata + per-metric
  labels merged, names-only, bounded, per-metric error tolerated.

---

## Part 2 — Explore range UX — `web/components/datasources/ExplorePanel.tsx`

### Control

Replace the `range` boolean checkbox with a single **range dropdown**:
`Instant | 5m | 15m | 1h | 6h | 24h` (default `Instant`). Only shown for `RANGE_KINDS`
(prometheus/mimir/loki). Loki keeps instant/range too.

- `Instant` → instant tool (as today).
- A window → range tool with `start = now - window`, `end = now`, `step = auto`.
- **Auto step**: `step = max(1, round(windowSeconds / 250))` (~250 points), passed through.
- **Auto re-run**: changing the dropdown re-runs the current query when a query string is present
  (fixes the "toggle does nothing" bug). Never auto-run on an empty query.

### Wire-through — query route + connector

- `web/app/api/datasources/query/route.ts`: body `range` becomes `{ window: <seconds>, step: <seconds> }`
  (or absent = instant). Validate numeric bounds (window ≤ 24h, step ≥ 1). When present and the
  spec has a `range` tool, pass `start`/`step` args to the connector (already accepted by
  `prometheus_query_range`). Keep backward-compat: a boolean `range:true` still maps to the 1h default.
- No connector code change required for the range path (args already supported).

### Visualization

- **Range** result (`shape:'series'`) → AreaTrend chart (unchanged).
- **Instant** result (`shape:'table'`): when row count ≤ 30 and `value` is numeric, render a
  ranked **horizontal bar chart** (value desc) ABOVE the table; > 30 rows → table only.
  Derived in `ResultView` from the existing table rows (`metric`, `value`) — **no normalizer
  change**. Reuse an existing recharts bar component if present, else add a small `BarRank`.

### Tests

- `ExplorePanel` test: dropdown renders presets; selecting a window posts `{ window, step }`;
  changing the dropdown re-runs; instant ≤30 rows shows bar chart, >30 table only.
- `web/app/api/datasources/query/route.test.ts`: `{ window, step }` → range tool with start/step;
  bounds validation; boolean back-compat.

---

## Architecture / boundaries

- **Connector Lambda** owns live Prometheus introspection (metadata + per-metric labels). The
  BFF never talks to Prometheus directly (SSRF surface stays in one guarded place).
- **`datasource-schema.ts`** owns cache shape, prioritization, and prompt rendering (pure where
  possible — render + prioritize are pure; cache I/O is isolated in `upsert/getSchema`).
- **`datasource-querygen.ts`** owns the prompt + the prose/read-only guards (unchanged guards).
- **`generate/route.ts`** orchestrates: cache → prioritize → lazy meta → cache-back → render →
  generate. The lazy-meta merge + top-K selection should be a small **pure helper** (testable
  without I/O), with the connector invoke + cache write kept in the route.
- **`ExplorePanel.tsx`** owns the console UX; visualization derives from `NormalizedResult` (no
  normalizer change). `query/route.ts` owns range-arg validation.

## Error handling

- Every new live call is best-effort and falls back to current behavior; generation/execution
  never blocks on meta introspection.
- Range-arg validation rejects out-of-bounds windows/steps at the route (400) before connector
  invoke; SSRF guard unchanged.
- Connector per-metric errors are skipped, not fatal.

## Security

- Read-only throughout (HTTP query API only; no mutation). Label **names** only.
- SSRF guard (`assertDatasourceEndpointAllowed`) applies before any connector invoke (unchanged).
- No secrets in schema/prompt; schema size cap (`MAX_SCHEMA_BYTES`) still enforced on cache-back.

## Rollout

- No new feature flag required (read-only enhancement to an existing shipped feature). Behavior
  degrades gracefully to current output when the connector/endpoint is unavailable.
- `make deploy` (web) + `make agentcore` (connector Lambda image) after merge to `feat/v2`.

## Out of scope / follow-ups

- topk-in-range flicker hinting; per-metric label-value sampling; non-Prometheus schema labels.
