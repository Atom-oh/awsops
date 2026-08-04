# Explore diag-signal chips — extend to all datasource kinds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Explore's "자주 쓰는 쿼리" (frequently-used query) chips work for every datasource kind, not just Kubernetes-flavored Prometheus/Mimir, by (a) widening the deterministic signal catalog with per-kind matchers, (b) adding an LLM hybrid fallback for a kind that matches nothing deterministically, and (c) removing the prometheus/mimir-only gates in the worker and the UI.

**Architecture:** `scripts/v2/workers/diagnosis/signal_catalog.py` gains a `matcher` field per catalog entry so `build_signals` dispatches to one of four pure matching strategies (metrics / table_columns / labels / tags_or_services) instead of assuming every entry matches on `schema['metrics']`. A new `scripts/v2/workers/diagnosis/signal_catalog_gen.py` mirrors `graph_querygen.py`'s prompt→static-check→dry-run pipeline, invoked by `datasource_index.py` only when a kind's deterministic catalog yields zero ready rows. `datasource_index.py` drops its `_DIAG_KINDS` restriction; `DiagSignalChips.tsx` drops its kind check.

**Tech Stack:** Python 3.9 (pytest) for the worker catalog/fallback; TypeScript/React (Vitest + Testing Library) for the chip component. No new dependencies.

## Global Constraints

- `build_signals(kind, schema)` and every matcher function stay PURE — no DB, no boto3, no egress, never raises (spec §Error handling).
- The LLM fallback is gated on `GRAPH_QUERYGEN_ENABLED` (reuse the existing env var — spec §Decision 2) and follows `graph_querygen.py`'s exact contract: any failure at any stage returns no candidates, never raises, never blocks the deterministic rebuild.
- `signal_catalog.CATALOG_VERSION` must be bumped once, at the end, after all catalog entries are added (spec §Decision 4) — forces a one-time rebuild across all instances via the existing daily dispatcher.
- `datasource_diag_signals` table schema is unchanged — no migration in this plan.
- Metric/table/label/tag names used in matchers are module constants only, never derived from user input (spec, `signal_catalog.py`'s existing docstring guarantee).

---

## File Structure

- Modify: `scripts/v2/workers/diagnosis/signal_catalog.py` — add `matcher` dispatch + per-kind `CATALOG` entries for clickhouse/loki/tempo/jaeger/dynatrace/datadog; bump `CATALOG_VERSION` (last task).
- Modify: `scripts/v2/workers/diagnosis/test_signal_catalog.py` — new test classes per matcher + per new kind's entries.
- Create: `scripts/v2/workers/diagnosis/signal_catalog_gen.py` — LLM hybrid fallback (mirrors `graph_querygen.py`).
- Create: `scripts/v2/workers/diagnosis/test_signal_catalog_gen.py` — mirrors `test_graph_querygen.py`'s injectable-invoke test shape.
- Modify: `scripts/v2/workers/datasource_index.py` — remove `_DIAG_KINDS` gate; call the new fallback when the catalog returns zero ready rows for a kind.
- Modify: `scripts/v2/workers/test_datasource_index.py` — update/add tests for the widened kind coverage and the fallback call.
- Modify: `web/components/datasources/DiagSignalChips.tsx` — drop the `kind === 'prometheus' || kind === 'mimir'` restriction.
- Modify: `web/components/datasources/DiagSignalChips.test.tsx` — replace the "renders nothing for a non-prom/mimir kind" test with one confirming chips now render for e.g. `loki`.

---

## Task 1: `matcher`-based dispatch in `build_signals`, existing 8 entries tagged `"metrics"`

**Files:**
- Modify: `scripts/v2/workers/diagnosis/signal_catalog.py`
- Test: `scripts/v2/workers/diagnosis/test_signal_catalog.py`

**Interfaces:**
- Produces: `build_signals(kind, schema)` — same signature/return shape as today (`{signal_key, title, status, query, missing_metrics, meta}` rows), but internally each `CATALOG` entry now carries a `"matcher"` key (`"metrics"` | `"table_columns"` | `"labels"` | `"tags_or_services"`) and matcher-specific required-fields keys (`required_metrics` / `required_columns` / `required_labels` / — none for `tags_or_services`). Later tasks add entries using the other three matchers; this task only wires the dispatch and re-tags the existing 8 without changing their behavior.

- [ ] **Step 1: Write the failing test — dispatch falls back correctly for an unknown matcher-tagged legacy entry**

Add to `scripts/v2/workers/diagnosis/test_signal_catalog.py` (top-level, alongside the existing classes):

```python
class TestMatcherDispatch:
    def test_existing_entries_are_tagged_metrics_matcher(self):
        assert all(sig.get("matcher") == "metrics" for sig in sc.CATALOG if sig["key"] in
                   ("container_cpu_throttling", "oom_kills", "node_memory_pressure",
                    "node_disk_usage", "network_pps", "pod_right_sizing", "cpu_saturation",
                    "pod_restarts"))

    def test_metrics_matcher_behavior_unchanged(self):
        # exact assertions from TestFullSchemaAllReady, re-run post-refactor as a regression guard
        rows = sc.build_signals("prometheus", {"metrics": ALL_METRICS})
        by = _by_key(rows)
        for key in ("container_cpu_throttling", "oom_kills", "node_memory_pressure",
                    "node_disk_usage", "network_pps", "pod_right_sizing", "cpu_saturation",
                    "pod_restarts"):
            assert by[key]["status"] == "ready"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/v2/workers/diagnosis && python -m pytest test_signal_catalog.py::TestMatcherDispatch -v`
Expected: FAIL — `AssertionError` (no `matcher` key exists yet on `CATALOG` entries), since `sig.get("matcher")` returns `None`.

- [ ] **Step 3: Implement matcher dispatch + tag existing entries**

In `scripts/v2/workers/diagnosis/signal_catalog.py`, add `"matcher": "metrics"` to each of the 8 existing `CATALOG` entries (e.g. the first becomes):

```python
    {
        "key": "container_cpu_throttling", "title": "컨테이너 CPU 스로틀링", "pillar": "performance",
        "matcher": "metrics",
        "required_metrics": ["container_cpu_cfs_throttled_periods_total", "container_cpu_cfs_periods_total"],
        "queries": [{
            "label": "throttled_ratio",
            "expr": ("topk(10, sum by(namespace,pod)(rate(container_cpu_cfs_throttled_periods_total[5m])) "
                     "/ clamp_min(sum by(namespace,pod)(rate(container_cpu_cfs_periods_total[5m])), 1))"),
        }],
        "threshold": 0.25, "unit": "ratio",
    },
```

(Repeat `"matcher": "metrics",` for the remaining 7 entries — `oom_kills`, `node_memory_pressure`, `node_disk_usage`, `network_pps`, `pod_right_sizing`, `cpu_saturation`, `pod_restarts` — no other field changes.)

Replace `build_signals` with a dispatcher that delegates missing-field computation per matcher, keeping the exact same row-building logic (status/query/missing_metrics/meta) as today:

```python
def _missing_for(sig, schema):
    """Return the list of missing required items for one catalog entry, per its matcher. Pure;
    never raises. An entry with an unrecognized/absent matcher is treated as always-missing
    (defensive — every entry added in this module must declare a matcher)."""
    matcher = sig.get("matcher")
    if matcher == "metrics":
        have = set()
        if isinstance(schema, dict):
            have = {m for m in (schema.get("metrics") or []) if isinstance(m, str)}
        return [m for m in sig["required_metrics"] if m not in have]
    if matcher == "table_columns":
        tables = (schema or {}).get("tables") or [] if isinstance(schema, dict) else []
        required = set(sig["required_columns"])
        for t in tables:
            if not isinstance(t, dict):
                continue
            cols = {c.get("name") for c in (t.get("columns") or []) if isinstance(c, dict)}
            if required.issubset(cols):
                return []
        return list(required)
    if matcher == "labels":
        have = set()
        if isinstance(schema, dict):
            have = {l for l in (schema.get("labels") or []) if isinstance(l, str)}
        return [l for l in sig["required_labels"] if l not in have]
    if matcher == "tags_or_services":
        # ready whenever the schema was successfully introspected at all (mirrors
        # graph_catalog._tempo_trace_spans: a reachable endpoint is the only capability needed)
        return [] if isinstance(schema, dict) else ["datasource has never been introspected"]
    return ["unrecognized matcher"]


def build_signals(kind, schema):
    """Resolve the catalog against a cached schema. Pure; never raises.

    kind: the datasource kind ('prometheus' | 'mimir' | 'clickhouse' | 'loki' | 'tempo' | 'jaeger' |
    'dynatrace' | 'datadog'). schema: the cached introspected schema dict — shape varies by kind
    (metrics/labels/tags/tables/services — see web/lib/datasource-schema.ts's docstring).
    Returns a list of rows: {signal_key, title, status, query|None, missing_metrics|None, meta}.
    """
    tool = _KIND_TOOL.get(kind, f"{kind}_query")
    rows = []
    for sig in CATALOG:
        missing = _missing_for(sig, schema)
        meta = {"pillar": sig["pillar"], "threshold": sig["threshold"],
                "kind": kind, "unit": sig["unit"]}
        if missing:
            rows.append({
                "signal_key": sig["key"], "title": sig["title"], "status": "unavailable",
                "query": None, "missing_metrics": missing, "meta": meta,
            })
        else:
            rows.append({
                "signal_key": sig["key"], "title": sig["title"], "status": "ready",
                "query": {"tool": tool, "queries": [dict(q) for q in sig["queries"]]},
                "missing_metrics": None, "meta": meta,
            })
    return rows
```

Note this task does NOT yet filter `CATALOG` by kind — every entry is still evaluated against every kind's schema (a clickhouse schema has no `metrics` key, so a `metrics`-matcher entry against it correctly returns "missing everything" via `_missing_for`'s `have = set()` fallback). Task 2 makes each entry kind-scoped.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/v2/workers/diagnosis && python -m pytest test_signal_catalog.py -v`
Expected: PASS — all existing tests (`TestFullSchemaAllReady`, `TestMissingMetrics`, `TestEmptyAndDefensive`, `TestCatalogShape`) plus the new `TestMatcherDispatch` pass unchanged, since the dispatcher's `"metrics"` branch reproduces the prior inline logic exactly.

- [ ] **Step 5: Commit**

```bash
git add scripts/v2/workers/diagnosis/signal_catalog.py scripts/v2/workers/diagnosis/test_signal_catalog.py
git commit -m "refactor(diag-signals): matcher-based dispatch in build_signals, no behavior change"
```

---

## Task 2: kind-scoping — each `CATALOG` entry declares which kind(s) it applies to

**Files:**
- Modify: `scripts/v2/workers/diagnosis/signal_catalog.py`
- Test: `scripts/v2/workers/diagnosis/test_signal_catalog.py`

**Interfaces:**
- Consumes: `_missing_for(sig, schema)`, `build_signals(kind, schema)` from Task 1.
- Produces: each `CATALOG` entry now carries a `"kinds"` key (`tuple[str, ...]`) — `build_signals` only evaluates an entry when `kind in sig["kinds"]`. This is required BEFORE Task 3 adds new entries, otherwise a clickhouse-only `table_columns` entry would spuriously show up (as `unavailable`, cluttering the chip list) for a prometheus instance too.

- [ ] **Step 1: Write the failing test**

```python
class TestKindScoping:
    def test_existing_k8s_entries_scoped_to_prometheus_and_mimir(self):
        for sig in sc.CATALOG:
            if sig["matcher"] == "metrics" and sig["key"] != "PLACEHOLDER_NONE":
                assert sig["kinds"] == ("prometheus", "mimir"), sig["key"]

    def test_build_signals_omits_entries_outside_their_kind(self):
        # a loki schema (no 'metrics' key at all) must not emit any of the 8 K8s metrics-matcher rows
        rows = sc.build_signals("loki", {"labels": ["job", "level"]})
        keys = {r["signal_key"] for r in rows}
        assert "cpu_saturation" not in keys
```

(Note: replace the placeholder key check with a concrete assertion once entries are known — this is refined at implementation time by asserting the literal 8 K8s keys again, as in Task 1's test, but checking `sig["kinds"]` instead of `sig["matcher"]`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/v2/workers/diagnosis && python -m pytest test_signal_catalog.py::TestKindScoping -v`
Expected: FAIL — `KeyError: 'kinds'` (no entry has a `"kinds"` field yet).

- [ ] **Step 3: Implement kind-scoping**

Add `"kinds": ("prometheus", "mimir")` to each of the 8 existing entries (same edit style as Task 1's `matcher` addition). Update `build_signals` to skip entries outside `kind`:

```python
def build_signals(kind, schema):
    tool = _KIND_TOOL.get(kind, f"{kind}_query")
    rows = []
    for sig in CATALOG:
        if kind not in sig["kinds"]:
            continue
        missing = _missing_for(sig, schema)
        ...  # unchanged from Task 1
    return rows
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/v2/workers/diagnosis && python -m pytest test_signal_catalog.py -v`
Expected: PASS. Also re-run `test_datasource_index.py` to confirm nothing downstream broke:
Run: `cd scripts/v2/workers && python -m pytest test_datasource_index.py -v`
Expected: PASS (the loki/tempo/prometheus graph-query tests are independent of `signal_catalog`, and `test_non_prom_kind_skipped`'s `skipped_kind` assertion is untouched — that gate is removed in Task 7, not here).

- [ ] **Step 5: Commit**

```bash
git add scripts/v2/workers/diagnosis/signal_catalog.py scripts/v2/workers/diagnosis/test_signal_catalog.py
git commit -m "feat(diag-signals): scope each catalog entry to its applicable kind(s)"
```

---

## Task 3: new `table_columns` matcher entries for clickhouse

**Files:**
- Modify: `scripts/v2/workers/diagnosis/signal_catalog.py`
- Test: `scripts/v2/workers/diagnosis/test_signal_catalog.py`

**Interfaces:**
- Consumes: `_missing_for`'s `"table_columns"` branch from Task 1 (already implemented — this task only adds catalog data, no matcher-logic changes).
- Produces: 3 new `CATALOG` entries, kind-scoped to `("clickhouse",)`, using `clickhouse_query` as the tool (matches `web/lib/datasource-query-tools.ts`'s `TOOL.clickhouse.instant`).

Each entry's `required_columns` is checked against `schema['tables'][i]['columns']` (schema shape confirmed in `agent/lambda/clickhouse_mcp.py:clickhouse_schema` — `{version, tables: [{name, columns: [{name, type}]}]}`). Query SQL uses a **placeholder table name** `{table}` that the BFF's chip-click flow does NOT support today (chips only pass a literal `expr` — see Task 6's follow-up note); for this plan, target the well-known OTel logs/metrics exporter shapes that ALSO appear as columns on the SAME table `graph_catalog.py` already resolves (`_clickhouse_trace_spans`), so the query can hardcode against `system.tables`-visible generic system data instead of requiring a specific table name match. Concretely:

```python
    {
        "key": "clickhouse_slow_queries", "title": "느린 쿼리 상위", "pillar": "performance",
        "matcher": "table_columns", "kinds": ("clickhouse",),
        "required_columns": ["query_duration_ms", "query"],
        "queries": [{
            "label": "slow_queries",
            "expr": ("SELECT query, query_duration_ms, event_time FROM system.query_log "
                     "WHERE type = 'QueryFinish' ORDER BY query_duration_ms DESC LIMIT 20"),
        }],
        "threshold": 1000, "unit": "ms",
    },
    {
        "key": "clickhouse_table_growth", "title": "테이블 크기 상위", "pillar": "cost",
        "matcher": "table_columns", "kinds": ("clickhouse",),
        "required_columns": ["database", "table", "bytes_on_disk"],
        "queries": [{
            "label": "table_bytes",
            "expr": ("SELECT database, table, sum(bytes_on_disk) AS bytes "
                     "FROM system.parts WHERE active GROUP BY database, table "
                     "ORDER BY bytes DESC LIMIT 20"),
        }],
        "threshold": 0, "unit": "bytes",
    },
    {
        "key": "clickhouse_error_log_rate", "title": "에러 로그 비율", "pillar": "reliability",
        "matcher": "table_columns", "kinds": ("clickhouse",),
        "required_columns": ["level", "message", "event_time"],
        "queries": [{
            "label": "error_rate",
            "expr": ("SELECT count() FROM system.text_log "
                     "WHERE level = 'Error' AND event_time >= now() - INTERVAL 1 HOUR"),
        }],
        "threshold": 0, "unit": "count",
    },
```

Because `system.query_log`/`system.parts`/`system.text_log` are ClickHouse SYSTEM tables (always present when the corresponding `system_log` is enabled server-side, not user tables), `_missing_for`'s `table_columns` branch as written in Task 1 (which scans `schema['tables']`) will NOT find them unless the connector's `clickhouse_schema` introspection includes system tables — but `agent/lambda/clickhouse_mcp.py:clickhouse_schema` explicitly EXCLUDES `system`/`INFORMATION_SCHEMA` (`WHERE database NOT IN (...)`). This means these three entries would always be `unavailable` under the current schema cache. **Resolve this by widening the matcher instead of the schema**: `table_columns` matching also accepts a `sig.get("system_table")` literal name that bypasses the schema-presence check entirely (system tables are ClickHouse built-ins, always queryable, no drift risk) — add:

```python
def _missing_for(sig, schema):
    matcher = sig.get("matcher")
    if matcher == "metrics":
        ...  # unchanged
    if matcher == "table_columns":
        if sig.get("system_table"):
            return []  # ClickHouse built-in system tables are always present — no schema check needed
        tables = (schema or {}).get("tables") or [] if isinstance(schema, dict) else []
        required = set(sig["required_columns"])
        for t in tables:
            if not isinstance(t, dict):
                continue
            cols = {c.get("name") for c in (t.get("columns") or []) if isinstance(c, dict)}
            if required.issubset(cols):
                return []
        return list(required)
    ...  # unchanged
```

Add `"system_table": True` to the three entries above (in place of relying on `required_columns` schema-matching); `required_columns` is kept only for documentation/title clarity, not used for matching when `system_table` is set.

- [ ] **Step 1: Write the failing test**

```python
class TestClickhouseSystemTableSignals:
    def test_system_table_signals_always_ready_for_clickhouse(self):
        rows = sc.build_signals("clickhouse", {"tables": []})  # empty user-table list
        by = _by_key(rows)
        for key in ("clickhouse_slow_queries", "clickhouse_table_growth", "clickhouse_error_log_rate"):
            assert by[key]["status"] == "ready", f"{key} should be ready (system table, schema-independent)"
            assert by[key]["query"]["tool"] == "clickhouse_query"

    def test_clickhouse_signals_absent_for_other_kinds(self):
        rows = sc.build_signals("prometheus", {"metrics": ALL_METRICS})
        keys = {r["signal_key"] for r in rows}
        assert "clickhouse_slow_queries" not in keys
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/v2/workers/diagnosis && python -m pytest test_signal_catalog.py::TestClickhouseSystemTableSignals -v`
Expected: FAIL — `KeyError` (entries don't exist yet).

- [ ] **Step 3: Implement**

Add the `system_table` branch to `_missing_for` and the three `CATALOG` entries with `"system_table": True`, exactly as drafted above.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/v2/workers/diagnosis && python -m pytest test_signal_catalog.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/v2/workers/diagnosis/signal_catalog.py scripts/v2/workers/diagnosis/test_signal_catalog.py
git commit -m "feat(diag-signals): clickhouse system-table signals (slow queries, table growth, error rate)"
```

---

## Task 4: new `labels` matcher entries for loki

**Files:**
- Modify: `scripts/v2/workers/diagnosis/signal_catalog.py`
- Test: `scripts/v2/workers/diagnosis/test_signal_catalog.py`

**Interfaces:**
- Consumes: `_missing_for`'s `"labels"` branch from Task 1.
- Produces: 3 new `CATALOG` entries, kind-scoped to `("loki",)`, tool `loki_query_range` (matches `TOOL.loki.range` in `datasource-query-tools.ts`; loki supports range queries per `RANGE_KINDS` in `ExplorePanel.tsx`).

```python
    {
        "key": "loki_error_rate", "title": "에러 로그 비율", "pillar": "reliability",
        "matcher": "labels", "kinds": ("loki",),
        "required_labels": ["job"],
        "queries": [{
            "label": "error_rate",
            "expr": 'sum by(job) (count_over_time({job=~".+"} |~ "(?i)error|exception|fatal" [5m]))',
        }],
        "threshold": 0, "unit": "count",
    },
    {
        "key": "loki_log_volume_by_namespace", "title": "네임스페이스별 로그량", "pillar": "cost",
        "matcher": "labels", "kinds": ("loki",),
        "required_labels": ["namespace"],
        "queries": [{
            "label": "volume",
            "expr": 'sum by(namespace) (count_over_time({namespace=~".+"} [5m]))',
        }],
        "threshold": 0, "unit": "count",
    },
    {
        "key": "loki_panic_grep", "title": "Panic·Fatal 로그", "pillar": "reliability",
        "matcher": "labels", "kinds": ("loki",),
        "required_labels": ["job"],
        "queries": [{
            "label": "panic_count",
            "expr": 'sum(count_over_time({job=~".+"} |~ "(?i)panic|fatal" [15m]))',
        }],
        "threshold": 0, "unit": "count",
    },
```

- [ ] **Step 1: Write the failing test**

```python
class TestLokiLabelSignals:
    def test_loki_signals_ready_when_labels_present(self):
        rows = sc.build_signals("loki", {"labels": ["job", "namespace", "level"]})
        by = _by_key(rows)
        for key in ("loki_error_rate", "loki_log_volume_by_namespace", "loki_panic_grep"):
            assert by[key]["status"] == "ready"
            assert by[key]["query"]["tool"] == "loki_query_range"

    def test_loki_signal_unavailable_when_required_label_missing(self):
        rows = sc.build_signals("loki", {"labels": ["level"]})  # no 'job', no 'namespace'
        by = _by_key(rows)
        assert by["loki_error_rate"]["status"] == "unavailable"
        assert "job" in by["loki_error_rate"]["missing_metrics"]
        assert by["loki_log_volume_by_namespace"]["status"] == "unavailable"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/v2/workers/diagnosis && python -m pytest test_signal_catalog.py::TestLokiLabelSignals -v`
Expected: FAIL — `KeyError` (entries don't exist yet).

- [ ] **Step 3: Implement**

Add the three `CATALOG` entries above.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/v2/workers/diagnosis && python -m pytest test_signal_catalog.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/v2/workers/diagnosis/signal_catalog.py scripts/v2/workers/diagnosis/test_signal_catalog.py
git commit -m "feat(diag-signals): loki label-matched signals (error rate, volume by namespace, panic grep)"
```

---

## Task 5: new `tags_or_services` matcher entries for tempo/jaeger, and `metrics` entries for dynatrace/datadog

**Files:**
- Modify: `scripts/v2/workers/diagnosis/signal_catalog.py`
- Test: `scripts/v2/workers/diagnosis/test_signal_catalog.py`

**Interfaces:**
- Consumes: `_missing_for`'s `"tags_or_services"` branch (Task 1) and `"metrics"` branch (already generic — dynatrace/datadog schemas are `{metrics: [...]}` per `dynatrace_mcp.py:dynatrace_schema` / `datadog_mcp.py:datadog_schema`, same shape as prometheus).
- Produces: 2 entries for `("tempo", "jaeger")` using `tags_or_services`, and 2 entries each for `("dynatrace",)` / `("datadog",)` using `metrics` — total 6 new entries.

Tempo/jaeger (tool differs by kind — `tempo_search` vs `jaeger_search`, so these need a per-kind tool override since `_KIND_TOOL` currently only maps prometheus/mimir):

```python
    {
        "key": "trace_recent_errors", "title": "최근 에러 트레이스", "pillar": "reliability",
        "matcher": "tags_or_services", "kinds": ("tempo", "jaeger"),
        "queries": [{"label": "error_traces", "expr": '{status=error}'}],
        "threshold": 0, "unit": "count",
    },
    {
        "key": "trace_slow_requests", "title": "느린 요청 상위", "pillar": "performance",
        "matcher": "tags_or_services", "kinds": ("tempo", "jaeger"),
        "queries": [{"label": "slow_traces", "expr": '{duration>500ms}'}],
        "threshold": 500, "unit": "ms",
    },
```

Dynatrace (tool `dynatrace_query`, metricSelector vocabulary per `dynatrace_mcp.py:dynatrace_query`):

```python
    {
        "key": "dynatrace_host_cpu", "title": "호스트 CPU 사용률", "pillar": "performance",
        "matcher": "metrics", "kinds": ("dynatrace",),
        "required_metrics": ["builtin:host.cpu.usage"],
        "queries": [{"label": "cpu_usage", "expr": "builtin:host.cpu.usage:avg"}],
        "threshold": 85, "unit": "percent",
    },
    {
        "key": "dynatrace_host_mem", "title": "호스트 메모리 사용률", "pillar": "reliability",
        "matcher": "metrics", "kinds": ("dynatrace",),
        "required_metrics": ["builtin:host.mem.usage"],
        "queries": [{"label": "mem_usage", "expr": "builtin:host.mem.usage:avg"}],
        "threshold": 85, "unit": "percent",
    },
```

Datadog (tool `datadog_query`, vocabulary per `datadog_mcp.py:datadog_query`'s example `avg:system.cpu.user{*}`):

```python
    {
        "key": "datadog_host_cpu", "title": "호스트 CPU 사용률", "pillar": "performance",
        "matcher": "metrics", "kinds": ("datadog",),
        "required_metrics": ["system.cpu.user"],
        "queries": [{"label": "cpu_user", "expr": "avg:system.cpu.user{*}"}],
        "threshold": 85, "unit": "percent",
    },
    {
        "key": "datadog_host_mem", "title": "호스트 메모리 사용률", "pillar": "reliability",
        "matcher": "metrics", "kinds": ("datadog",),
        "required_metrics": ["system.mem.used"],
        "queries": [{"label": "mem_used", "expr": "avg:system.mem.used{*}"}],
        "threshold": 0, "unit": "bytes",
    },
```

`_KIND_TOOL` needs widening so `build_signals`'s `tool = _KIND_TOOL.get(kind, f"{kind}_query")` resolves correctly for tempo/jaeger (their instant tool is `*_search`, not `*_query` — the current fallback `f"{kind}_query"` would wrongly produce `tempo_query`/`jaeger_query`, tools that don't exist per `datasource-query-tools.ts`):

```python
_KIND_TOOL = {
    "prometheus": "prometheus_query", "mimir": "mimir_query",
    "tempo": "tempo_search", "jaeger": "jaeger_search",
    "dynatrace": "dynatrace_query", "datadog": "datadog_query",
}
```

(clickhouse doesn't need an entry here — its three Task-3 entries hardcode `"tool": "clickhouse_query"` directly via the existing `system_table` path... actually they go through the same `tool = _KIND_TOOL.get(...)` line, so clickhouse must be added too: `"clickhouse": "clickhouse_query"`.)

- [ ] **Step 1: Write the failing test**

```python
class TestTraceAndApmSignals:
    def test_tempo_signals_ready_whenever_introspected(self):
        rows = sc.build_signals("tempo", {"tags": ["service.name"]})
        by = _by_key(rows)
        assert by["trace_recent_errors"]["status"] == "ready"
        assert by["trace_recent_errors"]["query"]["tool"] == "tempo_search"

    def test_jaeger_signals_ready_whenever_introspected(self):
        rows = sc.build_signals("jaeger", {"services": ["frontend"]})
        by = _by_key(rows)
        assert by["trace_slow_requests"]["status"] == "ready"
        assert by["trace_slow_requests"]["query"]["tool"] == "jaeger_search"

    def test_dynatrace_ready_when_metric_present(self):
        rows = sc.build_signals("dynatrace", {"metrics": ["builtin:host.cpu.usage"]})
        by = _by_key(rows)
        assert by["dynatrace_host_cpu"]["status"] == "ready"
        assert by["dynatrace_host_mem"]["status"] == "unavailable"

    def test_datadog_ready_when_metric_present(self):
        rows = sc.build_signals("datadog", {"metrics": ["system.cpu.user"]})
        by = _by_key(rows)
        assert by["datadog_host_cpu"]["status"] == "ready"
        assert by["datadog_host_cpu"]["query"]["tool"] == "datadog_query"

    def test_clickhouse_system_signals_still_use_clickhouse_query_tool(self):
        # regression: widening _KIND_TOOL must not change Task 3's tool resolution
        rows = sc.build_signals("clickhouse", {"tables": []})
        by = _by_key(rows)
        assert by["clickhouse_slow_queries"]["query"]["tool"] == "clickhouse_query"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/v2/workers/diagnosis && python -m pytest test_signal_catalog.py::TestTraceAndApmSignals -v`
Expected: FAIL — `KeyError` (entries/kinds don't exist yet).

- [ ] **Step 3: Implement**

Add the 6 `CATALOG` entries and widen `_KIND_TOOL` as drafted above.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/v2/workers/diagnosis && python -m pytest test_signal_catalog.py -v`
Expected: PASS — full suite, all matchers/kinds.

- [ ] **Step 5: Commit**

```bash
git add scripts/v2/workers/diagnosis/signal_catalog.py scripts/v2/workers/diagnosis/test_signal_catalog.py
git commit -m "feat(diag-signals): tempo/jaeger trace signals + dynatrace/datadog host metric signals"
```

---

## Task 6: LLM hybrid fallback — `signal_catalog_gen.py`

**Files:**
- Create: `scripts/v2/workers/diagnosis/signal_catalog_gen.py`
- Create: `scripts/v2/workers/diagnosis/test_signal_catalog_gen.py`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure new module — mirrors `graph_querygen.py`, which lives one directory up at `scripts/v2/workers/graph_querygen.py`; this new module is a sibling of `signal_catalog.py` inside `diagnosis/`).
- Produces: `try_generate_signal(kind, schema, integration_id, invoke_connector, invoke_llm=None)` → `dict | None`. Returns a row shaped like a `build_signals` ready row (`{signal_key, title, status: "ready", query: {tool, queries: [{label, expr}]}, missing_metrics: None, meta: {..., "provenance": "generated"}}`) on success, or `None` on ANY failure — never raises. Called by `datasource_index.py` (Task 7) only when `build_signals(kind, schema)` returned zero `ready` rows for that kind.

- [ ] **Step 1: Write the failing test — static check + dry-run gate, mirroring `test_graph_querygen.py`'s shape**

Create `scripts/v2/workers/diagnosis/test_signal_catalog_gen.py`:

```python
"""Tests for signal_catalog_gen — LLM hybrid fallback invoked when a kind's deterministic catalog
(signal_catalog.build_signals) yields zero ready rows. Mirrors graph_querygen.py's test shape:
every external call (LLM, connector dry-run) is injectable, so these tests make zero real calls.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pytest  # noqa: E402
import signal_catalog_gen as scg  # noqa: E402

SCHEMA = {"metrics": ["custom_app_requests_total", "custom_app_latency_seconds"]}


class TestGenerateQuery:
    def test_uses_the_injected_invoke_and_strips_markdown_fences(self):
        expr = scg._generate_expr("prometheus", SCHEMA, invoke=lambda p: "```\nrate(custom_app_requests_total[5m])\n```")
        assert expr == "rate(custom_app_requests_total[5m])"

    def test_prompt_includes_kind_and_schema_names(self):
        seen = {}
        def fake_invoke(prompt):
            seen["prompt"] = prompt
            return "rate(custom_app_requests_total[5m])"
        scg._generate_expr("prometheus", SCHEMA, invoke=fake_invoke)
        assert "custom_app_requests_total" in seen["prompt"] and "prometheus" in seen["prompt"]


class TestStaticCheck:
    def test_accepts_a_plausible_read_expression(self):
        assert scg._static_check("prometheus", "rate(x[5m])") is True

    def test_rejects_sql_mutating_keywords_for_clickhouse(self):
        assert scg._static_check("clickhouse", "DROP TABLE x") is False
        assert scg._static_check("clickhouse", "SELECT * FROM x; DROP TABLE x") is False

    def test_rejects_blank_or_non_string(self):
        assert scg._static_check("prometheus", "") is False
        assert scg._static_check("prometheus", None) is False


class TestDryRunCheck:
    def test_passes_when_the_connector_returns_without_error(self):
        assert scg._dry_run_check("prometheus", "up", 7, lambda args: {"result": {"shape": "vector"}}) is True

    def test_fails_on_a_connector_exception(self):
        def boom(args):
            raise RuntimeError("down")
        assert scg._dry_run_check("prometheus", "up", 7, boom) is False


class TestTryGenerateSignal:
    def _stub(self, monkeypatch, *, static_ok=True, dry_ok=True, expr="rate(custom_app_requests_total[5m])"):
        monkeypatch.setenv("GRAPH_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(scg, "_generate_expr", lambda kind, schema, invoke=None: expr)
        monkeypatch.setattr(scg, "_static_check", lambda kind, e: static_ok)
        monkeypatch.setattr(scg, "_dry_run_check", lambda kind, e, iid, invoke_connector: dry_ok)

    def test_returns_none_when_disabled(self, monkeypatch):
        monkeypatch.delenv("GRAPH_QUERYGEN_ENABLED", raising=False)
        assert scg.try_generate_signal("prometheus", SCHEMA, 7, lambda a: {}) is None

    def test_returns_a_ready_generated_row_when_every_check_passes(self, monkeypatch):
        self._stub(monkeypatch)
        row = scg.try_generate_signal("prometheus", SCHEMA, 7, lambda a: {})
        assert row["status"] == "ready" and row["meta"]["provenance"] == "generated"
        assert row["query"]["tool"] == "prometheus_query"
        assert row["query"]["queries"][0]["expr"] == "rate(custom_app_requests_total[5m])"

    def test_returns_none_when_the_static_check_fails(self, monkeypatch):
        self._stub(monkeypatch, static_ok=False)
        assert scg.try_generate_signal("prometheus", SCHEMA, 7, lambda a: {}) is None

    def test_returns_none_when_the_dry_run_fails(self, monkeypatch):
        self._stub(monkeypatch, dry_ok=False)
        assert scg.try_generate_signal("prometheus", SCHEMA, 7, lambda a: {}) is None

    def test_never_raises_when_generation_itself_throws(self, monkeypatch):
        monkeypatch.setenv("GRAPH_QUERYGEN_ENABLED", "true")
        def boom(kind, schema, invoke=None):
            raise RuntimeError("bedrock down")
        monkeypatch.setattr(scg, "_generate_expr", boom)
        assert scg.try_generate_signal("prometheus", SCHEMA, 7, lambda a: {}) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/v2/workers/diagnosis && python -m pytest test_signal_catalog_gen.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'signal_catalog_gen'`.

- [ ] **Step 3: Implement `signal_catalog_gen.py`**

```python
"""Hybrid LLM fallback for signal_catalog.py — invoked by datasource_index.py ONLY when a kind's
deterministic catalog (build_signals) matched zero ready rows, i.e. the instance's schema doesn't
overlap the curated per-kind vocabulary at all (a custom/non-standard instrumentation). Mirrors
graph_querygen.py's pipeline exactly, generalized across query languages (PromQL/LogQL/TraceQL/SQL/
metricSelector) instead of one hardcoded ClickHouse SQL shape.

Gated on GRAPH_QUERYGEN_ENABLED (shared with graph_querygen.py — same on/off intent: "is generation
allowed at all"); never raises; returns None on ANY failure at any stage, so the caller's signal
just stays absent (the deterministic catalog's own `unavailable` rows are the safe fallback).

Validation pipeline (a) static keyword guard (kind-appropriate — only clickhouse's SQL surface has
mutating verbs to reject; other query languages have none, so the check is a structural/blank check
only) and (b) a live dry-run against the connector, asserting a non-error response.
"""
import json
import logging
import os

_FORBIDDEN_SQL_KEYWORDS = (
    "insert", "update", "delete", "drop", "alter", "create", "truncate", "grant", "revoke",
    "attach", "detach", "rename", "optimize", "system", "kill", "exchange",
)

_KIND_TOOL = {
    "prometheus": "prometheus_query", "mimir": "mimir_query", "loki": "loki_query_range",
    "tempo": "tempo_search", "jaeger": "jaeger_search", "clickhouse": "clickhouse_query",
    "dynatrace": "dynatrace_query", "datadog": "datadog_query",
}

_VOCAB_KEY = {
    "prometheus": "metrics", "mimir": "metrics", "loki": "labels", "tempo": "tags",
    "jaeger": "services", "clickhouse": "tables", "dynatrace": "metrics", "datadog": "metrics",
}

_QUERY_LANG = {
    "prometheus": "PromQL", "mimir": "PromQL", "loki": "LogQL", "tempo": "TraceQL",
    "jaeger": "a Jaeger search query string", "clickhouse": "a read-only ClickHouse SQL SELECT",
    "dynatrace": "a Dynatrace metricSelector", "datadog": "a Datadog metric query",
}

_PROMPT_TEMPLATE = (
    "You are generating a single {lang} expression for a {kind} datasource, for an ops "
    "diagnostic dashboard. The datasource's schema has these {vocab_key}: {vocab}. Write ONE "
    "expression that surfaces a useful operational signal (error rate, latency, saturation, or "
    "volume) using ONLY names from the list above. Reply with ONLY the expression, no explanation, "
    "no markdown code fences."
)


def _vocab_names(schema, key):
    items = (schema or {}).get(key) or []
    names = []
    for x in items[:40]:
        if isinstance(x, str):
            names.append(x)
        elif isinstance(x, dict) and isinstance(x.get("name"), str):
            names.append(x["name"])
    return names


def _bedrock_invoke(prompt):
    """Default Bedrock invoke — identical model/pattern to graph_querygen._bedrock_invoke."""
    import boto3
    region = os.environ.get("AWS_REGION", "ap-northeast-2")
    model = os.environ.get("GRAPH_QUERYGEN_MODEL_ID", "global.anthropic.claude-haiku-4-5-20251001-v1:0")
    body = {"anthropic_version": "bedrock-2023-05-31", "max_tokens": 400,
            "messages": [{"role": "user", "content": prompt}]}
    resp = boto3.client("bedrock-runtime", region_name=region).invoke_model(modelId=model, body=json.dumps(body))
    payload = json.loads(resp["body"].read())
    return "".join(p.get("text", "") for p in payload.get("content", []))


def _generate_expr(kind, schema, invoke=None):
    """Ask the model for one query expression against `schema`'s vocabulary. `invoke` is injectable
    (tests never call Bedrock for real). May raise — the caller wraps this."""
    invoke = invoke or _bedrock_invoke
    vocab_key = _VOCAB_KEY.get(kind, "names")
    vocab = ", ".join(_vocab_names(schema, vocab_key)) or "(none)"
    prompt = _PROMPT_TEMPLATE.format(
        lang=_QUERY_LANG.get(kind, "query"), kind=kind, vocab_key=vocab_key, vocab=vocab)
    text = (invoke(prompt) or "").strip()
    if text.startswith("```"):
        text = text.strip("`").strip()
    return text.strip()


def _static_check(kind, expr):
    """(a) Structural guard. Pure; never raises."""
    if not isinstance(expr, str) or not expr.strip():
        return False
    if kind == "clickhouse":
        lowered = expr.lower()
        if ";" in expr.rstrip(";"):
            return False
        if not lowered.lstrip().startswith("select"):
            return False
        for kw in _FORBIDDEN_SQL_KEYWORDS:
            if f" {kw} " in f" {lowered} " or lowered.startswith(kw):
                return False
    return True


def _dry_run_check(kind, expr, integration_id, invoke_connector):
    """(b) Live dry run against the connector; False on ANY failure (conservative)."""
    tool = _KIND_TOOL.get(kind, f"{kind}_query")
    arg_name = "sql" if kind == "clickhouse" else "query"
    try:
        invoke_connector({arg_name: expr, "instance_id": integration_id})
        return True
    except Exception:
        return False


def try_generate_signal(kind, schema, integration_id, invoke_connector, invoke_llm=None):
    """Entry point, called from datasource_index.py only when signal_catalog.build_signals matched
    zero ready rows for this kind. Returns a ready row dict (same shape as build_signals' rows,
    plus meta.provenance='generated') on success, or None — never raises."""
    if os.environ.get("GRAPH_QUERYGEN_ENABLED") != "true":
        return None
    try:
        expr = _generate_expr(kind, schema, invoke=invoke_llm)
        if not _static_check(kind, expr):
            return None
        if not _dry_run_check(kind, expr, integration_id, invoke_connector):
            return None
        tool = _KIND_TOOL.get(kind, f"{kind}_query")
        return {
            "signal_key": "generated_signal", "title": "AI 생성 신호", "status": "ready",
            "query": {"tool": tool, "queries": [{"label": "generated", "expr": expr}]},
            "missing_metrics": None,
            "meta": {"kind": kind, "provenance": "generated"},
        }
    except Exception as e:  # noqa: BLE001 — never break the catalog-based rebuild
        logging.warning("[signal_catalog_gen] generation failed for integration %s: %s", integration_id, e)
        return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/v2/workers/diagnosis && python -m pytest test_signal_catalog_gen.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/v2/workers/diagnosis/signal_catalog_gen.py scripts/v2/workers/diagnosis/test_signal_catalog_gen.py
git commit -m "feat(diag-signals): LLM hybrid fallback for kinds with zero deterministic catalog matches"
```

---

## Task 7: wire the fallback + remove `_DIAG_KINDS` gate in `datasource_index.py`

**Files:**
- Modify: `scripts/v2/workers/datasource_index.py`
- Test: `scripts/v2/workers/test_datasource_index.py`

**Interfaces:**
- Consumes: `signal_catalog.build_signals(kind, schema)` (existing), `signal_catalog_gen.try_generate_signal(kind, schema, integration_id, invoke_connector, invoke_llm=None)` (Task 6).
- Produces: `run(payload, conn)` — same signature/contract as today, but `_rebuild_diag_signals` now runs for every kind (not just `_DIAG_KINDS`), and appends the generated fallback row when the catalog's own `rows` contains zero `ready` entries.

- [ ] **Step 1: Write the failing test — non-prom/mimir kind now gets diag signals built**

In `scripts/v2/workers/test_datasource_index.py`, replace `TestDefensive.test_non_prom_kind_skipped`:

```python
    def test_non_prom_kind_now_builds_diag_signals_too(self):
        # loki has its own kind-scoped catalog entries (signal_catalog.py) — no longer skipped.
        c = FakeConn(kind="loki", schema={"labels": ["job", "namespace"]})
        out = dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert "skipped_kind" not in out
        assert out.get("built", 0) > 0
        assert any(p["st"] == "ready" for p in c.inserts)
```

Also update the two existing assertions that reference `skipped_kind` for loki in `test_datasource_index.py` (`test_graph_build_happens_even_when_kind_is_out_of_diag_signal_scope` at the "Registry-driven graph sources" section) — since loki now HAS diag-signal catalog entries (Task 4), that test's premise ("out of diag-signal scope") is no longer true. Rename and adjust:

```python
    def test_graph_build_independent_of_diag_signal_build(self):
        # graph queries and diag signals are built from independent catalogs/tables — confirm both
        # run for loki now that it has its own diag-signal entries too (Task 4).
        c = FakeConn(kind="loki", schema={"labels": ["job", "namespace"]})
        out = dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert "skipped_kind" not in out
        assert len(c.graph_inserts) == 2  # graph queries: still always-unavailable for loki (graph_catalog.py)
```

Add a new test for the LLM fallback wiring:

```python
class TestGeneratedFallback:
    def test_fallback_invoked_and_appended_when_catalog_has_zero_ready(self, monkeypatch):
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "try_generate_signal": staticmethod(lambda kind, schema, iid, invoke_connector, invoke_llm=None: {
                "signal_key": "generated_signal", "title": "AI 생성 신호", "status": "ready",
                "query": {"tool": "loki_query_range", "queries": [{"label": "g", "expr": "count_over_time({job=\"x\"}[5m])"}]},
                "missing_metrics": None, "meta": {"kind": "loki", "provenance": "generated"},
            }),
        }))
        # a loki schema with NO recognized labels ("job"/"namespace") → catalog itself has zero ready
        c = FakeConn(kind="loki", schema={"labels": ["custom_label_only"]})
        out = dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert any(p["sk"] == "generated_signal" for p in c.inserts)

    def test_fallback_not_invoked_when_catalog_already_has_a_ready_row(self, monkeypatch):
        called = []
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "try_generate_signal": staticmethod(lambda *a, **k: called.append(1) or None),
        }))
        c = FakeConn(kind="loki", schema={"labels": ["job"]})  # loki_error_rate matches → 1+ ready
        dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert called == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/v2/workers && python -m pytest test_datasource_index.py -v`
Expected: FAIL — `test_non_prom_kind_now_builds_diag_signals_too` and the two `TestGeneratedFallback` tests fail (`_DIAG_KINDS` still gates loki out; `dsi._signal_gen` doesn't exist).

- [ ] **Step 3: Implement**

In `scripts/v2/workers/datasource_index.py`:

1. Remove the `_DIAG_KINDS = ("prometheus", "mimir")` line entirely.
2. Add the import (near the existing `graph_querygen` import):
   ```python
   import signal_catalog_gen as _signal_gen  # LLM hybrid fallback for signal_catalog's per-kind catalog
   ```
3. In `_rebuild_diag_signals`, after `rows = _cat.build_signals(kind, schema)`, add the fallback call before the upsert:
   ```python
   def _rebuild_diag_signals(conn, wdb, iid, kind, schema):
       version = _schema_version(schema)
       if wdb.read_signal_schema_version(conn, iid) == version:
           return {"skipped": True, "schema_version": version}
       rows = _cat.build_signals(kind, schema)  # present-but-empty metrics → all unavailable
       if not any(r["status"] == "ready" for r in rows):
           generated = _signal_gen.try_generate_signal(
               kind, schema, iid, lambda args: _lambda_invoke(kind, _cat._KIND_TOOL.get(kind, f"{kind}_query"), args))
           if generated:
               rows = list(rows) + [generated]
       conn.run("BEGIN")
       try:
           wdb.upsert_diag_signals(conn, iid, rows, version)
           wdb.sweep_diag_signals(conn, iid, [r["signal_key"] for r in rows])
           conn.run("COMMIT")
       except Exception:
           conn.run("ROLLBACK")
           raise
       return {"built": len(rows), "ready": sum(1 for r in rows if r["status"] == "ready"),
               "schema_version": version}
   ```
4. In `run()`, remove the `if kind in _DIAG_KINDS: ... else: out["skipped_kind"] = kind` branching — call `_rebuild_diag_signals` unconditionally for every kind:
   ```python
       out.update(_rebuild_diag_signals(conn, wdb, iid, kind, schema))
       out.update(_rebuild_graph_queries(conn, wdb, iid, kind, schema))
       return out
   ```
5. Update the module docstring's line `- datasource_diag_signals (diagnosis/signal_catalog.py) — prometheus/mimir only, v1 scope, unchanged.` to `- datasource_diag_signals (diagnosis/signal_catalog.py) — all datasource kinds; per-kind catalog + LLM hybrid fallback when a kind's catalog has zero ready matches.`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/v2/workers && python -m pytest test_datasource_index.py -v`
Expected: PASS — full suite. Also run the diagnosis subpackage suite to confirm no regressions:
Run: `cd scripts/v2/workers/diagnosis && python -m pytest -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/v2/workers/datasource_index.py scripts/v2/workers/test_datasource_index.py
git commit -m "feat(diag-signals): build diag signals for every kind, LLM fallback when catalog has zero matches"
```

---

## Task 8: drop the prometheus/mimir-only gate in `DiagSignalChips.tsx`

**Files:**
- Modify: `web/components/datasources/DiagSignalChips.tsx`
- Test: `web/components/datasources/DiagSignalChips.test.tsx`

**Interfaces:**
- Consumes: nothing new — same `GET /api/datasources/{id}/diag-signals` endpoint, same `ReadySignal`/`UnavailableSignal` shapes.
- Produces: `DiagSignalChips({ instanceId, kind, onPick })` — same props/behavior, but `enabled` no longer excludes non-prometheus/mimir kinds.

- [ ] **Step 1: Write the failing test**

In `web/components/datasources/DiagSignalChips.test.tsx`, replace the `'renders nothing for a non-prom/mimir kind (no fetch)'` test:

```javascript
  it('renders chips for a non-prom/mimir kind (loki) now that it has its own catalog', async () => {
    render(<DiagSignalChips instanceId={7} kind="loki" onPick={vi.fn()} />);
    await waitFor(() => screen.getByText('OOM Kill')); // SIGNALS fixture is kind-agnostic in this test file
    expect((global.fetch as any)).toHaveBeenCalledWith('/api/datasources/7/diag-signals');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run components/datasources/DiagSignalChips.test.tsx`
Expected: FAIL — the `enabled` check still excludes `loki`, so `fetch` is never called and `getByText('OOM Kill')` times out.

- [ ] **Step 3: Implement**

In `web/components/datasources/DiagSignalChips.tsx`, change:

```typescript
  const enabled = !!instanceId && (kind === 'prometheus' || kind === 'mimir');
```

to:

```typescript
  const enabled = !!instanceId;
```

Also update the component's doc comment (currently `// ... Prom/Mimir only (others have no pre-built signals).`) to `// ... All datasource kinds now have kind-scoped catalog entries (see signal_catalog.py).`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run components/datasources/DiagSignalChips.test.tsx`
Expected: PASS — both the updated test and the existing `'renders nothing without an instanceId'` test (unaffected — `instanceId` is still required).

- [ ] **Step 5: Commit**

```bash
git add web/components/datasources/DiagSignalChips.tsx web/components/datasources/DiagSignalChips.test.tsx
git commit -m "feat(explore): show diag-signal chips for every datasource kind, not just prometheus/mimir"
```

---

## Task 9: bump `CATALOG_VERSION` and run the full worker + web test suites

**Files:**
- Modify: `scripts/v2/workers/diagnosis/signal_catalog.py`

**Interfaces:**
- Produces: `CATALOG_VERSION = "v2"` (forces every existing instance's `schema_version` hash to change, per spec §Decision 4 — triggers a one-time rebuild across all instances via the existing daily dispatcher, no manual backfill).

- [ ] **Step 1: Bump the version**

```python
CATALOG_VERSION = "v2"  # bumped 2026-08-04: kind-scoped matchers + clickhouse/loki/tempo/jaeger/
                         # dynatrace/datadog catalog entries + LLM hybrid fallback (was "v1")
```

- [ ] **Step 2: Run the full worker test suite**

Run: `cd scripts/v2/workers && python -m pytest -v`
Expected: PASS — every test file (`test_datasource_index.py`, `diagnosis/test_signal_catalog.py`, `diagnosis/test_signal_catalog_gen.py`, `test_graph_querygen.py`, `diagnosis/test_datasources.py`, etc.).

- [ ] **Step 3: Run the full web test suite scoped to the touched files**

Run: `cd web && npx vitest run components/datasources/ lib/diag-signals`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/v2/workers/diagnosis/signal_catalog.py
git commit -m "chore(diag-signals): bump CATALOG_VERSION to force a one-time rebuild across all instances"
```

---

## Self-Review Notes

- **Spec coverage:** Decision 1 (per-kind matchers) → Tasks 1–5. Decision 2 (LLM fallback) → Task 6–7. Decision 3 (remove kind gates) → Tasks 7–8. Decision 4 (`CATALOG_VERSION` bump) → Task 9. Testing section's four bullet points → Tasks 1–8's test steps respectively.
- **Type/name consistency:** `try_generate_signal`'s signature (`kind, schema, integration_id, invoke_connector, invoke_llm=None`) is used identically in Task 6's tests and Task 7's wiring call. `_KIND_TOOL` in `signal_catalog.py` (Task 5) and the separate `_KIND_TOOL` in `signal_catalog_gen.py` (Task 6) are two distinct module-level dicts in two different files — intentional, not a naming collision, since `signal_catalog_gen.py` must resolve tool names even for a kind the deterministic catalog otherwise skips.
- **Deferred to a future change (out of this plan's scope):** the ExplorePanel chip-click flow (`onPick(expr)` → `run(undefined, expr)`) only ever fills+runs a literal query string — it has no way to pass extra `args` (e.g. `max_rows` for clickhouse). Task 3's clickhouse queries are plain SQL strings compatible with this, so no ExplorePanel change is needed in this plan.
