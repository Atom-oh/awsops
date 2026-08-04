# Explore diagnostic-signal chips — extend to all datasource kinds
# Explore "자주 쓰는 쿼리" 칩 — 전체 데이터소스 kind로 확장

**Status:** Approved 2026-08-04.

## 요약 (한국어)

Explore 패널의 "자주 쓰는 쿼리" 칩(`DiagSignalChips`)이 prometheus/mimir 두 kind에만 게이트되어
있고, 그 카탈로그(`signal_catalog.py`) 8개 항목이 전부 Kubernetes 전용 메트릭(cadvisor/
kube-state-metrics/node-exporter)만 요구한다. 그 결과 K8s가 아닌 Prometheus나 다른 kind
(clickhouse/loki/tempo/jaeger/dynatrace/datadog)를 연결하면 `cpu_saturation`(node_cpu_seconds_total만
요구) 하나만 유일하게 "ready"가 되어, 어떤 데이터소스를 넣어도 "높은 CPU" 카드만 뜨는 버그가 된다.

이 설계는 (1) kind별 매칭 전략(matcher)을 카탈로그에 추가해 5종 전부에 5~8개 신규 질문 템플릿을
채우고, (2) 결정론적 카탈로그가 전부 unavailable일 때만 스키마의 실제 이름을 근거로 LLM(Bedrock
Haiku)이 후보 쿼리를 생성해 정적 검사 + dry-run으로 검증하는 하이브리드 폴백(`graph_querygen.py`
패턴 재사용)을 추가하고, (3) `datasource_index.py`의 `_DIAG_KINDS` 게이트와 `DiagSignalChips.tsx`의
kind 제한을 제거해 모든 kind에서 칩이 뜨도록 한다.

## Problem

`ExplorePanel` → `DiagSignalChips` renders "자주 쓰는 쿼리" (frequently-used query) chips sourced
from `datasource_diag_signals`, built by `scripts/v2/workers/diagnosis/signal_catalog.py`'s
`build_signals(kind, schema)`.

Two compounding issues:

1. **Catalog scope**: all 8 `CATALOG` entries require Kubernetes-stack metric names
   (`container_cpu_cfs_*`, `kube_pod_container_status_*`, `node_memory_*`, `node_filesystem_*`,
   `node_network_*`, `kube_pod_container_resource_requests`). Only `cpu_saturation`
   (`node_cpu_seconds_total`) is a metric present on *any* node-exporter-backed Prometheus, K8s or
   not. So connecting a non-K8s Prometheus (or any Prometheus missing kube-state-metrics/cadvisor)
   makes exactly one signal ready — always the CPU one — regardless of what's actually in the
   instance's schema.
2. **Kind gate**: `DiagSignalChips.tsx`'s `enabled` flag and `datasource_index.py`'s `_DIAG_KINDS`
   both hardcode `("prometheus", "mimir")`. clickhouse/loki/tempo/jaeger/dynatrace/datadog never get
   diag-signal chips at all, even though their cached schemas (tables/columns, labels, tags,
   services) carry enough shape to build kind-appropriate "frequent query" suggestions.

## What already exists (reused, not rebuilt)

- **The ready/unavailable + schema-version-gated rebuild pattern**: `datasource_diag_signals` table,
  `db.py`'s `upsert_diag_signals`/`read_signal_schema_version`/`sweep_diag_signals`, and
  `datasource_index.py`'s mark-sweep transaction — unchanged. This design only changes *which kinds*
  call it and *what the catalog contains*.
- **The capability-driven, per-kind matcher shape**: `graph_catalog.py` already resolves a *different*
  match strategy per kind (clickhouse → table/column shape, tempo → schema-presence, prometheus/mimir
  → metric-name presence, loki → structurally unavailable). `signal_catalog.py` adopts the same idea
  for diagnostic (not graph) signals.
- **The LLM hybrid-fallback pipeline**: `graph_querygen.py`'s `try_generate_clickhouse_trace_spans` —
  prompt template → static read-only/single-statement check → advisory Code Interpreter check → live
  `LIMIT 1` dry-run — is the exact shape reused for the new diag-signal fallback, just parameterized
  per kind instead of hardcoded to one ClickHouse table shape.
- **Cached schema shapes**: unchanged (`web/lib/datasource-schema.ts`'s docstring: `tables`
  (clickhouse), `metrics` (prometheus/mimir/dynatrace/datadog), `labels` (prometheus/mimir/loki),
  `tags` (tempo), `services` (jaeger)).

## Decisions

### 1. Catalog gains a `matcher` field; each entry declares its own match strategy

Today every `CATALOG` entry implicitly matches on `required_metrics` against `schema['metrics']`.
Each entry gets an explicit `"matcher"` key so `build_signals` dispatches instead of assuming one
shape:

- `matcher: "metrics"` (existing 8 K8s entries, unchanged behavior) — `required_metrics` ⊆
  `schema['metrics']`. Also used for new dynatrace/datadog entries (their schema is `metrics: [...]`
  too).
- `matcher: "table_columns"` (clickhouse) — entry declares `required_columns: [...]`; ready when some
  table in `schema['tables']` has a superset of those columns (mirrors `graph_catalog._OTEL_REQUIRED_COLUMNS`
  matching, generalized to non-trace shapes like slow-query/error-count tables).
- `matcher: "labels"` (loki) — entry declares `required_labels: [...]`; ready when `schema['labels']`
  is a superset.
- `matcher: "tags_or_services"` (tempo/jaeger) — ready whenever the schema was introspected at all
  (mirrors `graph_catalog._tempo_trace_spans`: a reachable endpoint is the only capability needed),
  OR (for jaeger) `schema['services']` non-empty.

New entries per kind (5–8 each, titles are illustrative — exact PromQL/SQL/LogQL/TraceQL text is an
implementation detail decided during planning, not this spec):

| kind | new signal examples |
|---|---|
| clickhouse | slow queries top-N, error-log rate (if a log-shaped table exists), table row-count growth, disk usage by table, query count by user |
| loki | error-log rate spike, warn/error ratio by namespace, log volume by job, panic/fatal grep hit count |
| tempo / jaeger | slowest services (p95 latency), highest error-rate services, most-called service pairs, trace count by service |
| dynatrace / datadog | problem/alert count, top hosts by CPU/mem tag, anomaly count by entity |

Each new entry follows the existing row shape: `{signal_key, title, status, query, missing_metrics|missing_*, meta}`.

### 2. LLM hybrid fallback — only when the deterministic catalog is fully empty for a kind

If, after matching, **zero** entries for the instance's kind are `ready`, a new
`signal_catalog_gen.py` (mirrors `graph_querygen.py`) is invoked with the instance's actual schema
names (table/column names, or label/tag/service names) to generate 3–5 candidate signal queries via
Bedrock Haiku. Each candidate goes through:

1. Static read-only / single-statement check (kind-appropriate: reuse the SQL guard for clickhouse;
   a lighter "no mutating verbs" check for PromQL/LogQL/TraceQL, which have no mutating verbs to begin
   with, so this step is a no-op pass-through for those).
2. Live dry-run against the connector (`{kind}_query` / `{kind}_search` with the smallest applicable
   window/limit), asserting a non-error, non-empty-shape response.

Only candidates that pass both are persisted as `ready` rows with `meta.provenance = "generated"`;
everything else stays `unavailable`. This is gated on the same `GRAPH_QUERYGEN_ENABLED` flag (renamed
scope-wise in docs to cover both call sites; the env var itself is unchanged) — default off, so
today's zero-LLM-cost behavior for K8s Prometheus/Mimir is unaffected.

### 3. Remove the kind gates

- `datasource_index.py`: delete `_DIAG_KINDS` restriction — `_rebuild_diag_signals` runs for every
  kind (the catalog itself safely returns all-`unavailable` for a kind with no matching entries, so
  this is a no-op widening, not a behavior change for kinds not yet covered by step 1).
- `DiagSignalChips.tsx`: `enabled = !!instanceId` (drop the `kind === 'prometheus' || kind === 'mimir'`
  check). The component already renders `null` when both `ready` and `unavailable` are empty, so no
  extra guard is needed for kinds with nothing built yet.

### 4. `CATALOG_VERSION` bump

Bumping `signal_catalog.CATALOG_VERSION` forces every existing instance's `schema_version` hash to
change, triggering a one-time rebuild across all instances via the existing daily dispatcher — no
manual backfill needed.

## Data model

No schema changes. `datasource_diag_signals` keeps its existing columns; `query` JSONB shape is
unchanged (`{tool, queries: [{label, expr}]}` for metrics-matcher entries — table/label/tag-matcher
entries populate the same shape with a kind-appropriate `tool` name, e.g. `clickhouse_query`,
`loki_query_range`, `tempo_search`, `jaeger_query`).

## Error handling

Unchanged posture: `build_signals` stays a pure function (no exceptions for any matcher branch — an
unmatched/malformed schema just yields more `unavailable` rows). The new LLM fallback follows
`graph_querygen.py`'s contract exactly — any failure at any stage returns `None`/no candidates,
never raises, never blocks the deterministic rebuild.

## Testing

- `test_signal_catalog.py`: one test class per new matcher (`table_columns`, `labels`,
  `tags_or_services`) mirroring the existing `TestMissingMetrics`/`TestFullSchemaAllReady` shape —
  full schema → all new entries ready; a schema missing one required column/label/tag → that entry
  (and only that entry) unavailable with the right `missing_*` list.
- New `test_signal_catalog_gen.py` (or extend `test_graph_querygen.py`'s pattern): injectable `invoke`
  for the LLM call, injectable connector invoke for dry-run — assert a bad/mutating candidate is
  rejected, a valid candidate that fails dry-run is rejected, a valid candidate that passes both is
  returned with `provenance: "generated"`.
- `test_datasource_index.py`: assert `_rebuild_diag_signals` is now called (not skipped) for a
  non-prometheus/mimir kind.
- `ExplorePanel.test.tsx` / `DiagSignalChips` test: assert chips render for a non-prometheus kind
  when the API returns ready signals.
