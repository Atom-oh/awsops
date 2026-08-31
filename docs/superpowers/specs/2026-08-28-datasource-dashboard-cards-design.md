# Datasource dashboard cards — schema-driven pre-built card set with stored queries
# 데이터소스 대시보드 카드 — 스키마 기반 예상 카드 사전 생성 + 쿼리 사전 저장

**Status:** Approved 2026-08-28 (live-execution-on-view variant chosen by owner).
Branch `feat/datasource-dashboard-cards`.

## 요약 (한국어)

datasource를 등록하면(및 일일 인덱스 배치마다) 캐시된 스키마(`datasource_schemas`)를 근거로
**예상되는 대시보드 카드 세트를 미리 생성**해 신규 테이블 `datasource_dashboard_cards`에
저장한다 — 각 카드가 사용할 **쿼리문이 사전 저장**된다(칩 `datasource_diag_signals`와 동일한
query JSONB shape). `/integrations/datasources/[id]` 상세 페이지 상단의 새 "대시보드" 섹션이
저장된 카드를 읽고, ready 카드마다 저장된 쿼리를 **조회 시점에 기존 `POST
/api/datasources/query`로 라이브 실행**해 stat/시계열 카드로 렌더한다. 결정론적 카탈로그만
사용(LLM 생성 없음 — 칩의 flag-gated LLM 폴백 패턴은 후속 결정), 신규 Terraform/IAM 없음,
ULID 마이그레이션 1건. 카드 빌드는 기존 인덱스 잡의 `datasource_diagnosis_enabled`
게이트(기본 false)를 그대로 따른다.

## Problem

Registering an external datasource today yields Explore (a blank query console) plus the
"자주 쓰는 쿼리" chips. The owner wants the registration itself to produce a ready-made
dashboard: expected KPI/chart cards derived from the actual cached schema, with each card's
query persisted ahead of time — so opening the datasource shows a working overview without
authoring queries.

## What already exists (reused, not rebuilt)

- **Schema cache on registration**: `web/app/api/datasources/manage/route.ts` POST →
  `warmSchemaCache()` → `upsertSchema()` (`datasource_schemas`) → `enqueueDatasourceIndex()`.
  Registration hook needs no change — the index job is where cards get built.
- **Pre-built-query precedent**: `scripts/v2/workers/datasource_index.py` +
  `diagnosis/signal_catalog.py` → `datasource_diag_signals` (pure `build_signals(kind, schema)`,
  ready/unavailable rows, schema-hash skip, atomic upsert+sweep). Cards clone this shape
  WITHOUT the LLM-budget machinery (deterministic only).
- **Query execution**: `POST /api/datasources/query` (`{id, query, range:{window, step}}`) —
  read-only, SSRF-guarded, range-validated, point-capped. Cards execute through it verbatim.
- **Chart rendering**: ExplorePanel's existing multi-series chart / value renderers.
- **Read route pattern**: `app/api/datasources/[id]/diag-signals/route.ts` +
  `web/lib/diag-signals.ts`.

## Decisions

### Data model — new table `datasource_dashboard_cards` (ULID migration)

One row per (integration, card):

```sql
CREATE TABLE IF NOT EXISTS datasource_dashboard_cards (
  account_id     text NOT NULL DEFAULT 'self',
  integration_id bigint NOT NULL,
  card_key       text NOT NULL,
  title          text NOT NULL,
  viz            text NOT NULL,          -- 'stat' | 'timeseries' | 'table'
  unit           text NOT NULL DEFAULT '',
  status         text NOT NULL,          -- 'ready' | 'unavailable' | 'unknown' (truncated-schema indeterminate)
  query          jsonb,                                 -- {tool, expr, range:{window,step}|null}; NULL when not ready
  missing        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- missing/undetermined metrics/labels/columns
  schema_version text NOT NULL DEFAULT '',
  built_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, integration_id, card_key)
);
```

Separate from `datasource_diag_signals` on purpose: that table's read path filters bookkeeping
sentinel keys and gates LLM provenance; mixing a second content family into it couples two
lifecycles. Cards carry no LLM rows, so no budget machinery; an empty build DOES write the `__schema_version__` sentinel row (excluded on read) so a no-card schema is remembered, not rebuilt every run.

### Card catalog — `scripts/v2/workers/card_catalog.py` (pure, flat like graph_catalog)

`build_cards(kind, schema) -> list[row]`, same purity contract as `signal_catalog.build_signals`
(no DB/boto3/egress; schema values can only make a card `unavailable`, never inject — all
expressions are module constants; the ONLY schema-derived splice is the ClickHouse table name,
validated per dot-segment against `^[A-Za-z0-9_]+$` (1–2 segments, `table` or `db.table` — clickhouse_mcp introspection emits db-qualified names) and spliced backtick-quoted per segment, else `unavailable`). `CARD_CATALOG_VERSION` is
mixed into the schema hash so catalog edits force a rebuild.

Initial deterministic catalog (per kind, matched against the cached schema shape):

- **prometheus / mimir** (`metrics[]` matching, PromQL, tool `prometheus_query`/`mimir_query`):
  Matching is against `schema.metrics` PLUS the connector's per-name probe results: the
  `{kind}_schema` tools accept `probe_metrics` (datasource_index passes
  `card_catalog.required_metrics()`), and each named metric is decided by LOCAL membership in
  the full un-capped in-memory name list — zero extra network calls, and definitive regardless
  of the alphabetical 500-name response cap (every kube-prometheus stack exceeds it).
  Locally-present names past the cap merge into `metrics`; every requested (valid) name lands in
  `schema.probed`, which the catalog treats as DEFINITIVE — a probed-and-absent requirement is a
  confident `unavailable` even under truncation (only unprobed misses stay `unknown`). A FAILED
  bulk name fetch decides nothing: no `probed`, and the schema is marked `truncated` so misses
  degrade to `unknown`, never a confident `unavailable`.
  1. `up_targets` — stat: `sum(up)` (requires `up`; NOT `count(up == 1)`, which is an empty
     instant vector during a total outage and would render "값 없음" instead of the honest 0)
  2. `cpu_usage` — timeseries: `100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)`
     (requires `node_cpu_seconds_total`; unit %)
  3. `memory_available` — timeseries: `sum(node_memory_MemAvailable_bytes)` (unit bytes)
  4. `container_cpu` — timeseries: `topk(5, sum by (namespace) (rate(container_cpu_usage_seconds_total[5m])))`
  5. `pod_restarts` — stat: `sum(increase(kube_pod_container_status_restarts_total[1h]))`
- **loki** (`labels[]` matching, LogQL, tool `loki_query_range`):
  1. `log_volume` — timeseries: `sum(count_over_time({job=~".+"}[5m]))` (requires label `job`;
     falls back to `app` then `namespace` as the anchor label — first present label wins)
  2. `error_rate` — timeseries: `sum(count_over_time({job=~".+"} |~ "(?i)error" [5m]))` (same anchor)
- **tempo** (`tags[]` matching, TraceQL, tool `tempo_search`):
  1. `slow_traces` — stat/list: `{ duration > 1s }`
  2. `error_traces` — stat/list: `{ status = error }` (both require no specific tag — always ready
     when the schema row exists; tag-conditional variants are future work)
- **clickhouse** (`tables[]` matching, SQL, tool `clickhouse_query`):
  1. `otel_span_rate` — timeseries-ish stat: `SELECT count() AS value FROM <traces_table> WHERE Timestamp > now() - INTERVAL 1 HOUR` (the `AS value` alias is load-bearing — the stat renderer reads `rows[0].value`)
     where `<traces_table>` = the first table named `otel_traces` (exact, and it must carry a
     `Timestamp` column — the stored queries filter on it) else a table with `Timestamp` +
     `TraceId` AND a trace-ONLY column (`Duration`, `ParentSpanId`, or `SpanKind`). `SpanId` is
     explicitly NOT a discriminator: the standard `otel_logs` table carries
     Timestamp+TraceId+SpanId+ServiceName, so accepting SpanId would confidently report log rows
     as span counts in a logs-only pipeline (regression-tested); validated identifier, else
     `unavailable`
  2. `top_services` — table/stat: `SELECT ServiceName, count() AS spans FROM <traces_table> WHERE Timestamp > now() - INTERVAL 1 HOUR GROUP BY ServiceName ORDER BY spans DESC LIMIT 5`
     (requires `ServiceName` column)

Every card row: `{card_key, title(Korean), viz, unit, status, query:{tool, expr, range}, missing}`.
`range` is stored with the card (`{window: 3600, step: 60}` for timeseries; `null` for instant).

### Worker wiring — extend `datasource_index.py`

In the per-instance loop, next to the diag-signal build: compute
`card_version = hash(schema + CARD_CATALOG_VERSION)`; if it equals the stored version
(`schema_version` agreement across the instance's card rows, read like
`read_signal_schema_version` does), skip; else `build_cards(kind, schema)` → single transaction:
`upsert_dashboard_cards` + sweep rows not in the written set (mark-sweep, same as chips but with
no sentinel special-cases — an empty build writes one `__schema_version__` bookkeeping row,
excluded on read). New `db.py` helpers `upsert_dashboard_cards` / `read_card_schema_version`,
cloned from the diag-signal ones minus budget logic. Same kinds as the index pipeline today
(prometheus/mimir/loki/tempo/clickhouse).

Instance deletion: `web/lib/datasources.ts` delete path adds
`DELETE FROM datasource_dashboard_cards WHERE integration_id=$1` next to the diag-signals sweep.

Card building inherits the index job's gate: it runs only when `datasource_diagnosis_enabled` is
true (default false; requires `workers_enabled`/`agentcore_enabled`/`integrations_enabled`) — the
"no new Terraform" claim means no NEW gate, not no gate.

### BFF read — `GET /api/datasources/[id]/cards`

`web/lib/dashboard-cards.ts` `getDashboardCards(integrationId)` (clone of `diag-signals.ts`
read: `account_id='self'`, exclude `__schema_version__`, split ready/unavailable) +
`app/api/datasources/[id]/cards/route.ts` (auth + generic error), identical conventions to the
diag-signals route.

### UI — dashboard section on `/integrations/datasources/[id]`

New client component `web/components/datasources/CardDashboard.tsx` rendered above
`ExplorePanel` on the detail page:

- Fetch `/api/datasources/[id]/cards`. Empty + no rows → render nothing (zero-noise for kinds
  with no catalog or index not yet run).
- Each `ready` card lazily executes its stored query via `POST /api/datasources/query`
  (`{id, query: card.query.expr, range: card.query.range ?? undefined}`), with concurrency
  capped at 3 (sequential batches) to avoid hammering the connector.
- Render: `stat` → big-number card (first sample value, unit suffix); `timeseries` → small
  area/line card reusing the Explore chart primitives (first ≤5 series); result-shape
  mismatch or query error → the card body shows an inline error state (never hides the card).
- `unavailable` cards render dimmed with a "누락: …" tooltip (same UX as chips).
- An "open in Explore" affordance is NOT shipped — ExplorePanel exposes no external query setter
  today; revisit if one is added.

### Testing

- `scripts/v2/workers/test_card_catalog.py` — per-kind matcher tests (ready/unavailable,
  anchor-label fallback for loki, clickhouse table resolution incl. identifier-validation
  rejection), catalog purity (no egress imports), version bump behavior.
- `scripts/v2/workers/test_datasource_index.py` — extend: card build skip on version match,
  atomic upsert+sweep, empty-build sentinel.
- `web/lib/dashboard-cards.test.ts` — read split + sentinel exclusion (clone diag-signals test).
- `web/components/datasources/CardDashboard.test.tsx` — render states (ready/unavailable/error),
  concurrency batching (following DiagSignalChips.test.tsx conventions).

## Out of scope

- LLM-generated cards (chips' flag-gated fallback pattern is a later decision).
- jaeger/dynatrace/datadog (not wired into the index pipeline).
- Pre-executed/cached card RESULTS (owner chose live execution on view).
- User-editable/custom card definitions.
