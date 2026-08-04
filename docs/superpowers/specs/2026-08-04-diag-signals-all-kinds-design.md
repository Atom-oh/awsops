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

> Superseded points are **corrected in place** below and the reason recorded in
> [Amended 2026-08-04](#amended-2026-08-04-implementation-reality) — the review found the two sections
> asserting different truths (all kinds vs 5 kinds, 3–5 candidates vs one, shared flag vs its own), which
> made the spec unusable as a reference (review MAJOR, L5-M1).

### 1. Catalog gains a `matcher` field; each entry declares its own match strategy

Today every `CATALOG` entry implicitly matches on `required_metrics` against `schema['metrics']`.
Each entry gets an explicit `"matcher"` key so `build_signals` dispatches instead of assuming one
shape:

- `matcher: "metrics"` (existing 8 K8s entries, unchanged behavior) — `required_metrics` ⊆
  `schema['metrics']`. (Planned dynatrace/datadog entries were dropped — those kinds are not wired into
  the index pipeline; see Amended #2.)
- `matcher: "table_columns"` (clickhouse) — entry declares `required_columns: [...]`; ready when some
  table in `schema['tables']` has a superset of those columns (mirrors `graph_catalog._OTEL_REQUIRED_COLUMNS`
  matching, generalized to non-trace shapes like slow-query/error-count tables).
- `matcher: "labels"` (loki) — entry declares `required_labels: [...]`; ready when `schema['labels']`
  is a superset.
- `matcher: "tags_or_services"` (tempo only; jaeger is not wired — Amended #2) — ready whenever the
  schema was introspected at all
  (mirrors `graph_catalog._tempo_trace_spans`: a reachable endpoint is the only capability needed),
  OR (for jaeger) `schema['services']` non-empty.

New entries per kind (5–8 each, titles are illustrative — exact PromQL/SQL/LogQL/TraceQL text is an
implementation detail decided during planning, not this spec):

| kind | new signal examples |
|---|---|
| clickhouse | **none shipped** — the assumed `system.*` shape is not exposed that way, so clickhouse is fallback-only (Amended #1) |
| loki | error-log rate spike, warn/error ratio by namespace, log volume by job, panic/fatal grep hit count |
| tempo | slowest services (p95 latency), highest error-rate services, most-called service pairs, trace count by service |
| ~~jaeger / dynatrace / datadog~~ | **dropped** — not wired into the index pipeline (Amended #2) |

Each new entry follows the existing row shape: `{signal_key, title, status, query, missing_metrics|missing_*, meta}`.

### 2. LLM hybrid fallback — only when the deterministic catalog is fully empty for a kind

If, after matching, **zero** entries for the instance's kind are `ready`, a new
`signal_catalog_gen.py` (mirrors `graph_querygen.py`) is invoked with the instance's actual schema
names (table/column names, or label/tag/service names) to generate **ONE** candidate signal expression via
Bedrock Haiku (3–5 was the plan; one keeps the cost and the review surface proportionate to a chip —
Amended #3). The candidate goes through:

1. Static read-only / single-statement check (kind-appropriate: reuse the SQL guard for clickhouse;
   a lighter "no mutating verbs" check for PromQL/LogQL/TraceQL, which have no mutating verbs to begin
   with, so this step is a no-op pass-through for those).
2. A **relevance** gate: the expression must mention this instance's own schema vocabulary and must not
   merely measure a constant (`SELECT 1`, `vector(1)`, a name inside a string literal or an alias). This
   was not in the plan and is the gate most of the review passes were spent on.
3. Live dry-run against the connector (`{kind}_query` / `{kind}_search` with the smallest applicable
   window/limit and, per connector, whatever bound it accepts: ClickHouse `max_execution_time=5` +
   `max_rows=1`, Prometheus/Mimir the API's `timeout=5s`, Loki/Tempo `limit=1` — Loki and Tempo expose no
   server-side execution bound through their connectors), asserting a non-error response. An empty response
   is retryable, not a verdict — a quiet window is not a wrong query.

Only a candidate that passes all three is persisted as a `ready` row with `meta.provenance = "generated"`;
everything else stays `unavailable`. Generated rows feed the **Explore chips only** — `_signal_plan`
excludes them from the diagnosis report, which judges severity from `pillar`/`threshold` that a generated
row does not have. Gated on its **own** `diag_signal_querygen_enabled` (NOT the shared
`GRAPH_QUERYGEN_ENABLED` the plan assumed — Amended #4), default off, so today's zero-LLM-cost behavior
for K8s Prometheus/Mimir is unaffected. Note the schema identifiers (table/metric/label names) of the
external datasource are sent to Bedrock; no credentials are.

### 2b. Scope of the fallback (what it does NOT do)

Two limits, both deliberate and both easy to misread from the section above:

- It fires only when a kind's deterministic catalog produces **zero** ready rows. The "non-K8s Prometheus
  shows a single CPU chip" case has one ready row, so it does not trigger — improving *partial* catalog
  matching is a separate change, not this one (review MAJOR: the motivating example is not covered).
- Loki and Tempo have **no server-side execution bound** reachable through their connectors — only `limit`.
  A heavy LogQL/TraceQL can therefore hold the connector Lambda until its own timeout; ClickHouse
  (`max_execution_time` + `timeout_overflow_mode=throw`) and Prometheus/Mimir (`timeout`) do have one. This
  asymmetry is accepted for a `limit=1` dry run and is the reason the generated expression is not put on any
  automated recurring path.
- Generated rows reach the **Explore chips only**. `_signal_plan` excludes them from the diagnosis report,
  because that prompt judges severity from `pillar`/`threshold` which a generated row does not carry. So
  the report's loki/tempo/clickhouse coverage is unchanged by this feature; the chips are what widen.

### 3. Remove the kind gates

- `datasource_index.py`: widen `_DIAG_KINDS` to the 5 wired connector kinds — `_rebuild_diag_signals`
  runs for each of them (the catalog itself safely returns all-`unavailable` for a kind with no matching entries, so
  this is a no-op widening, not a behavior change for kinds not yet covered by step 1).
- `DiagSignalChips.tsx`: `enabled = !!instanceId` (drop the `kind === 'prometheus' || kind === 'mimir'`
  check). The component already renders `null` when both `ready` and `unavailable` are empty, so no
  extra guard is needed for kinds with nothing built yet.

### 4. `CATALOG_VERSION` bump

Bumping `signal_catalog.CATALOG_VERSION` forces every existing instance's `schema_version` hash to
change, triggering a one-time rebuild across all instances via the existing daily dispatcher — no
manual backfill needed.

## Amended 2026-08-04 (implementation reality)

The panel review found this spec and the implementation disagreeing on five points. The implementation
is what shipped; the spec is corrected here rather than the code being bent to match a plan written
before the connectors were probed.

1. **No clickhouse `system_table` entries.** The planned three deterministic clickhouse signals assumed
   an OTel-exporter-shaped `system.*` layout that the connector does not expose the same way, so they
   would have been permanently `unavailable`. `build_signals("clickhouse", …)` returns `[]` by design
   (the tests assert exactly that), which makes clickhouse a fallback-only kind.
2. **No jaeger/dynatrace/datadog entries.** The planned six entries are dropped: those kinds are not
   wired into the index pipeline at all — `DIAG_SIGNAL_KINDS` (BFF enqueue), the daily dispatcher's
   `_LIST_SQL` and the worker's `ds_connector_arns` are each 5-kind. Catalog entries alone would never
   be built. Wiring them is follow-up work, and until then the honest scope of this change is
   **prometheus / mimir / loki / tempo, plus clickhouse via the flag-gated LLM fallback**.
3. **One generated candidate, not 3–5.** Decision 2 above says "3–5 candidate signal queries"; the
   implementation asks for a single expression and validates that one. Generating several would
   multiply the Bedrock cost and the dry-run traffic for a chip that only ever shows one query, and
   nothing consumes the runners-up.
4. **`CATALOG_VERSION` is `v4`, not `v2`.** main is on `v1`; `v2` and `v3` existed only in intermediate
   commits of this branch, so deployed instances move v1 → v4 in one step. The v3 → v4 step is not a
   catalog edit: v3 encoded "generation budget exhausted" as the plain schema hash, which is
   indistinguishable from the legitimate "conclusively nothing to build" row that must keep skipping, so a
   row written that way would never generate again. The bump invalidates every hash once, and from v4 on
   exhaustion is `:spent<week>` while the plain hash means only "conclusive".
5. **The dry run now enforces the non-empty shape this spec already required.** Decision 2 asks for "a
   non-error, non-empty-shape response", but the first implementation accepted any successful envelope —
   so an invented metric name returning Prometheus `result: []` was stored as a ready chip that stays
   permanently empty. `_nonempty_result()` checks the payload per kind.

Two further review findings changed code, not scope: a schema whose catalog yields nothing now records
its `schema_version` through a sentinel row (`db.SCHEMA_VERSION_SENTINEL_KEY`, filtered out of the BFF
read) instead of leaving no row at all — with no row there is no version, so `datasource_index` rebuilt
every run and re-invoked Bedrock daily wherever the flag is on; and `DiagSignalChips` clears its chip
state at the start of every effect, since after the kind gate was removed a failed fetch on a datasource
switch left the previous instance's chips clickable.

The version is recorded only when the outcome is CONCLUSIVE. `try_generate_signal_with_status()` reports DISABLED / REJECTED / TRANSIENT / GENERATED, and on TRANSIENT (Bedrock throttled, connector down — anything that threw) the rows are still written but under `{version}:pendN w<week>` — a marker the skip check treats as "a retry is owed", so the next run rebuilds; once the week is settled it becomes `:doneN w<week>` and the daily job skips outright. REJECTED is treated
the same way: the model is not deterministic and the gates change, so a single failed gate is not a
permanent fact about the schema (a later review found the plain-version encoding froze it). Only DISABLED
records the plain version — and the flag is part of the hash, so flipping it rebuilds anyway. This is not limited to an empty build: loki/tempo normally produce `unavailable` rows, and persisting those under the real version would skip the retry just as effectively (a second review pass caught exactly that). Recording the version there would have frozen a retryable failure into a permanent skip: the schema never changes, so the daily job would skip forever and the signal would never appear even after the outage ended (review finding on the first version of the sentinel).

Decision 2 said this would ride on `GRAPH_QUERYGEN_ENABLED` ("renamed scope-wise in docs"). It does
not: the fallback has its own flag, `diag_signal_querygen_enabled` /
`DIAG_SIGNAL_QUERYGEN_ENABLED`, default off. Consenting to "one ClickHouse graph query" is not
consenting to LLM generation plus live dry runs across every fallback-eligible kind on every daily
run, and four models across three lenses said so twice. Both flags are now in BASELINE §2's gated
register, which the first version of this PR left untouched — an anti-drift violation in its own
right.

Two more gates were added to the generated query, beyond what Decision 2 described:
- **it must name something from the instance's own schema.** `SELECT 1` and `vector(1)` passed the
  static check and the dry run — they execute and return a row — and were stored as ready "AI 생성
  신호" that the diagnosis report then trusted. A constant unrelated to the datasource is worse than
  no signal, because it is a silent misdiagnosis. Deterministic rows get this via `_missing_for`;
  generated ones bypassed it.
- **an empty dry-run result is retryable, not conclusive.** A quiet window returns no samples, and
  treating that as a verdict froze the instance signal-less until the schema drifted.

A third pass found the anchor check alone insufficient: a query can name a real table and still measure nothing (`SELECT 1 FROM spans`, `vector(1)`), so the value position is checked too: for clickhouse the SELECT list must name a column or table from the instance's schema (with `count()` / `count(*)` allowed as the one column-free aggregate that is a real signal), and elsewhere the whole expression must not be `vector(N)` / `scalar(N)`. The FROM has to name a schema table too, since `count()` over `system.tables` measures nothing about the datasource. The gate reads the REAL cached shape — `tables` is a LIST of `{name, columns:[{name,type}]}`, per `web/lib/datasource-schema.ts` and `graph_catalog._clickhouse_trace_spans` — and also accepts the dict form the tests use and a bare list of names; an earlier version assumed the dict only and so rejected every ClickHouse query against a real schema. A cached `otel.spans` also matches an unqualified `FROM spans`, the legitimate current-database spelling — but only unqualified: `FROM other_db.spans` is a different table that happens to share a name, so the FROM check refuses a qualifier it did not cache. Table references are PARSED (a small identifier tokenizer honouring `` ` `` and `"` quoting) rather than regex-matched, so `` `other_db`.`spans` `` (qualified) and `` `other_db.spans` `` (one identifier containing a dot) stay distinct. The earlier version stripped quotes globally, which flattens those two into the same text; on the expressions tested both forms behave the same, so the parser is not closing a live bypass — it removes the need to mangle the input and makes the residual ambiguity explicit: the CACHE stores one string, so `otel.spans` could be db+table or a dotted name, and both readings are honoured. Column matching stays permissive, since `SELECT s.duration` is how a column is normally written.

Later passes added four things the earlier ones had not reached:

- **A connector 4xx is NOT a verdict** (this reverses an earlier draft of this spec, which a later review
  found to be the reverse of the shipped code). `prometheus_mcp.py`'s handler wraps upstream failures, SSRF
  blocks and runtime errors alike into `err(...)` = 400, so a 503 from the datasource arrives as a 400 and
  "4xx means the query is wrong" would freeze a genuine outage into a skip. Every exception is TRANSIENT,
  and the cost is bounded the other way instead: at most `_MAX_GENERATION_ATTEMPTS` tries per ISO week,
  after which the instance is parked for the rest of the week. The budget is per INSTANCE per week: the
  marker is read whatever version prefixes it, because the version hashes the whole schema and a production
  Prometheus changes its metric set on every deploy — keying the cap to the version made it a daily call.
  A conclusive outcome keeps the week's usage (`:doneN`), so an instance whose catalog match flaps in and
  out cannot buy a fresh budget per flap.
- **The static check must not be looser than the connector it feeds.** It lacked the ClickHouse
  table-function denylist, so `FROM url('http://169.254.169.254/…')` reached the dry run and the check
  itself became the egress attempt. `_TABLE_FN` now mirrors `clickhouse_mcp.py` deliberately — a check that
  disagrees with the real guard is worse than none, because it invites treating this one as the boundary.
- **Aliases cannot impersonate schema names.** `SELECT 1 AS duration FROM spans` and
  `FROM numbers(10) AS spans` borrowed the vocabulary without measuring anything from it; `AS <name>` is
  stripped before matching.
- **Loki metric LogQL renders as a series.** The chips added here are aggregates, which Loki answers with
  resultType `matrix`; the renderer only handled log streams and would have read a numeric sample as a log
  line. It now delegates matrix/vector to the Prometheus renderer, whose shape is identical.

Also stated, not changed: the loki/tempo/clickhouse signal rows are consumed by the Explore CHIPS, not by
the diagnosis report — `sources.py` still gates `_signal_plan` to prom/mimir, deliberately, because
widening it needs per-kind thresholds/pillars. The plan builder's hardcoded `{"query": …}` arg key WAS
fixed though (ClickHouse's connector takes `sql`), since the rows already exist and that is a landmine for
whoever opens the gate.

This gate took nine review passes to settle, and the pattern is worth recording: each pass found a real defect — two where my check rejected legitimate queries, one where I had written it against the unit-test schema shape rather than the cached one, five where a bypass remained — which is what a lexical test for *semantic* relevance costs. It stays because rejecting obvious nonsense is cheap and the failure mode it prevents (a fabricated signal presented as real) is quiet. It is not a boundary: execution is read-only, the row is labelled `provenance='generated'`, and a person sees the chip. Three earlier attempts were wrong in different directions: "the select list contains a letter" let `SELECT 1 AS x FROM spans` through, and a boundary that refused a preceding dot rejected ordinary SQL like `SELECT s.duration FROM spans s`. Both checks are a lexical floor, not a proof of relevance — the same caveat `agent/lambda/CLAUDE.md` makes about keyword denylists applies, and what actually bounds the damage is that execution goes through the read-only connector, the row is labelled `provenance='generated'`, and a person sees the chip before trusting it.

Two follow-on corrections from the next review pass: the flag has to be mixed into `_schema_version` (only the graph flag was, so turning the new one on left every already-indexed instance's version unchanged → skip → the fallback never ran for the instances it was added for), and the vocabulary check matches whole tokens rather than substrings — plain `in` let `SELECT 1 GROUP BY 1` match a metric named `up` inside "GROUP", and `SELECT count() FROM system.tables` match a clickhouse column named `count`. For dict-shaped schemas only TABLE names anchor, since every SQL query needs a FROM while column names are generic enough to match by accident.

While adding the vocabulary gate, `_vocab_names` turned out to raise `TypeError` on clickhouse's
dict-shaped `tables` — inside the caller's try/except that surfaced as TRANSIENT on every run, so
clickhouse could never generate a signal and retried forever. Fixed, with tests for both shapes.

## Data model

No schema changes. `datasource_diag_signals` keeps its existing columns; `query` JSONB shape is
unchanged (`{tool, queries: [{label, expr}]}` for metrics-matcher entries — table/label/tag-matcher
entries populate the same shape with a kind-appropriate `tool` name, e.g. `clickhouse_query`,
`loki_query_range`, `tempo_search`, `jaeger_search`).  <!-- corrected 2026-08-04: the code has _search -->

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
