"""Tests for datasource_index.run — schema-cache read → stable hash → rebuild-on-change.

Widened (registry-driven graph sources, 2026-07-08) to also: (a) accept `kind` in the payload (the
dispatcher now looks it up once so the job never has to), (b) attempt a live re-introspection via the
connector's `{kind}_schema` tool and write back to datasource_schemas on drift, falling back to the
cache on any failure, and (c) build pre-computed topology-graph queries (graph_catalog.py) across ALL
5 datasource kinds — independent of the diag-signals build, which stays prometheus/mimir-only.

A by-pattern FakeConn drives the real db helpers (upsert/read-version/sweep) through run(), so the
test exercises the actual SQL helpers too. No Aurora, no real connector egress: `_reintrospect` is
stubbed to a deterministic no-op (returns None, i.e. "introspection unavailable") by the autouse
fixture UNLESS a test explicitly overrides it — this is what keeps the suite from making real boto3
calls now that live re-introspection exists.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pytest  # noqa: E402
import datasource_index as dsi  # noqa: E402


@pytest.fixture(autouse=True)
def _enable(monkeypatch):
    monkeypatch.setenv("DIAG_DATASOURCES_ENABLED", "true")  # M2: run() is gated on this
    # Default: no live egress in tests — introspection "fails" (returns None), so run() falls back
    # to the cached schema exactly like before this feature existed. Tests of the live path override.
    monkeypatch.setattr(dsi, "_reintrospect", lambda kind, iid: None)

PROM_METRICS = [
    "container_cpu_cfs_throttled_periods_total", "container_cpu_cfs_periods_total",
    "kube_pod_container_status_last_terminated_reason",
    "node_memory_MemAvailable_bytes", "node_memory_MemTotal_bytes",
    "node_filesystem_avail_bytes", "node_filesystem_size_bytes",
    "node_network_receive_packets_total", "node_network_receive_drop_total",
    "container_memory_working_set_bytes", "kube_pod_container_resource_requests",
    "node_cpu_seconds_total", "kube_pod_container_status_restarts_total",
]

OTEL_COLUMNS = [{"name": n, "type": "String"} for n in
                ("TraceId", "SpanId", "ParentSpanId", "ServiceName", "Timestamp", "Duration",
                 "ResourceAttributes", "SpanAttributes")]


class FakeConn:
    """Returns by SQL substring; records inserts/deletes. Tracks diag-signal writes (`inserts`/
    `deletes`, unchanged names/meaning from before this feature) and graph-query writes
    (`graph_inserts`/`graph_deletes`, new) independently, since the two tables have independent
    schema-version hashes and independent skip-on-unchanged behavior."""
    def __init__(self, *, kind="prometheus", metrics=PROM_METRICS, schema_present=True,
                 schema=None, existing_version=None, existing_graph_version=None):
        self.kind, self.metrics, self.schema_present = kind, metrics, schema_present
        self._schema_override = schema
        self.existing_version = existing_version
        self.existing_graph_version = existing_graph_version
        self.inserts, self.deletes = [], []
        self.graph_inserts, self.graph_deletes = [], []
        self.schema_writes = []

    def run(self, sql, **p):
        if "FROM datasource_schemas" in sql:
            if not self.schema_present:
                return []
            schema = self._schema_override if self._schema_override is not None else \
                {"metrics": self.metrics, "version": "2.50"}
            return [[self.kind, json.dumps(schema)]]
        if "COUNT(DISTINCT schema_version)" in sql and "datasource_diag_signals" in sql:
            return [[1, self.existing_version]] if self.existing_version is not None else [[0, None]]
        if "COUNT(DISTINCT schema_version)" in sql and "datasource_graph_queries" in sql:
            return [[1, self.existing_graph_version]] if self.existing_graph_version is not None else [[0, None]]
        if sql.strip().startswith("INSERT INTO datasource_diag_signals"):
            self.inserts.append(p); return []
        if sql.strip().startswith("DELETE FROM datasource_diag_signals"):
            self.deletes.append(p); return []
        if sql.strip().startswith("INSERT INTO datasource_graph_queries"):
            self.graph_inserts.append(p); return []
        if sql.strip().startswith("DELETE FROM datasource_graph_queries"):
            self.graph_deletes.append(p); return []
        if sql.strip().startswith("INSERT INTO datasource_schemas"):
            self.schema_writes.append(p); return []
        return []


class TestRebuildOnChange:
    def test_changed_schema_builds_upserts_and_sweeps(self):
        c = FakeConn(existing_version="STALE")
        out = dsi.run({"integration_id": 7}, c)
        assert out["built"] == 8 and out.get("skipped") is not True
        assert len(c.inserts) == 8                 # one upsert per signal
        assert len(c.deletes) == 1                 # one mark-sweep
        assert all(p["iid"] == 7 for p in c.inserts)

    def test_unchanged_schema_skips_rebuild(self):
        # build once to learn the deterministic version, then feed it back as existing
        c0 = FakeConn(existing_version="STALE")
        dsi.run({"integration_id": 7}, c0)
        version = c0.inserts[0]["sv"]
        c = FakeConn(existing_version=version)
        out = dsi.run({"integration_id": 7}, c)
        assert out.get("skipped") is True
        assert c.inserts == [] and c.deletes == []

    def test_hash_is_stable_across_calls(self):
        a = FakeConn(existing_version="x"); dsi.run({"integration_id": 1}, a)
        b = FakeConn(existing_version="y"); dsi.run({"integration_id": 1}, b)
        assert a.inserts[0]["sv"] == b.inserts[0]["sv"]  # deterministic (sha256, not salted hash())


class TestEmptyVsError:
    def test_missing_cache_preserves_rows_and_skips(self):
        c = FakeConn(schema_present=False)
        out = dsi.run({"integration_id": 7}, c)
        assert out.get("no_schema") is True
        assert c.inserts == [] and c.deletes == []   # preserve last-good; no destructive sweep

    def test_present_but_empty_metrics_rebuilds_all_unavailable(self):
        c = FakeConn(metrics=[], existing_version="STALE")
        out = dsi.run({"integration_id": 7}, c)
        assert len(c.inserts) == 8
        assert all(p["st"] == "unavailable" for p in c.inserts)  # not preserved — rebuilt unavailable
        assert len(c.deletes) == 1


class TestDefensive:
    def test_never_raises_on_conn_error(self):
        class Boom:
            def run(self, *a, **k):
                raise RuntimeError("db down")
        out = dsi.run({"integration_id": 7}, Boom())
        assert out.get("error")  # surfaced, not raised

    def test_non_prom_kind_skipped(self):
        c = FakeConn(kind="loki")
        out = dsi.run({"integration_id": 7}, c)
        assert out.get("skipped_kind") == "loki"
        assert c.inserts == []


# ── Task 11: end-to-end smoke — catalog → index(build) → diag_signals → collect → coverage "사용" ──
def test_e2e_index_to_collect_to_coverage(monkeypatch):
    """One worker-side flow with injected fixtures (no AWS): index builds ready signals → collect_datasources
    executes them → _coverage_note reports the datasource as '사용'."""
    import json as _json
    from diagnosis import sources as src
    from diagnosis import report as rpt

    # 1) index builds signals from a cached schema (capture the upserted ready rows)
    idx = FakeConn(existing_version="STALE")
    out_idx = dsi.run({"integration_id": 5}, idx)
    assert out_idx["ready"] >= 1
    built = [p for p in idx.inserts if p["st"] == "ready"]

    # 2) feed the built rows back as datasource_diag_signals + drive collect_datasources
    signal_rows = [[p["sk"], p["sk"], p["st"], p["q"], p["mm"], p["me"]] for p in idx.inserts]

    class FlowConn:
        def run(self, sql, **kw):
            if "FROM integrations" in sql:
                return [(5, "prod-prom", "prometheus", True)]
            if "FROM datasource_diag_signals" in sql:
                return signal_rows
            return []

    import io
    class FakeLambda:
        def invoke(self, FunctionName, Payload):  # noqa: N803
            env = _json.dumps({"statusCode": 200,
                               "body": _json.dumps({"result": {"shape": "vector", "series": [{"v": 1}]}})}).encode()
            return {"Payload": io.BytesIO(env)}
    monkeypatch.setenv("DIAG_DATASOURCES_ENABLED", "true")
    monkeypatch.setattr(src, "_lambda_client", lambda: FakeLambda())

    out = src.collect_datasources(FlowConn())
    assert out["ok"] and out["data"]["queried"] == 1
    assert out["data"]["findings"][0].get("source") == "signals"

    # 3) coverage note reports the datasource as used
    note = rpt._coverage_note({"datasources_obs": out})
    assert "사용" in note and "prod-prom" in note


class TestAccountKeyFallback:
    """M1: a BFF/worker HOST_ACCOUNT_ID mismatch must NOT blank the build — integration_id fallback."""
    def test_schema_found_via_integration_id_when_account_scope_misses(self):
        class MismatchConn:
            def __init__(self):
                self.inserts, self.deletes = [], []
                self.graph_inserts, self.graph_deletes = [], []
                self.schema_writes = []
            def run(self, sql, **p):
                if "FROM datasource_schemas" in sql:
                    # account-scoped query misses (BFF wrote under a different account key); fallback hits
                    if "account_id IN" in sql:
                        return []
                    return [["prometheus", json.dumps({"metrics": PROM_METRICS})]]
                if "COUNT(DISTINCT schema_version)" in sql:
                    return [[0, None]]
                if sql.strip().startswith("INSERT INTO datasource_diag_signals"):
                    self.inserts.append(p); return []
                if sql.strip().startswith("DELETE FROM datasource_diag_signals"):
                    self.deletes.append(p); return []
                if sql.strip().startswith("INSERT INTO datasource_graph_queries"):
                    self.graph_inserts.append(p); return []
                if sql.strip().startswith("DELETE FROM datasource_graph_queries"):
                    self.graph_deletes.append(p); return []
                return []
        c = MismatchConn()
        out = dsi.run({"integration_id": 7}, c)
        assert out.get("built") == 8 and out.get("no_schema") is not True   # fallback found the schema
        assert len(c.inserts) == 8


def test_gate_off_no_build(monkeypatch):
    """M2: with the feature gate off, run() no-ops (no write) even though the job was enqueued."""
    monkeypatch.delenv("DIAG_DATASOURCES_ENABLED", raising=False)
    c = FakeConn(existing_version="STALE")
    out = dsi.run({"integration_id": 7}, c)
    assert out.get("disabled") is True
    assert c.inserts == [] and c.deletes == []
    assert c.graph_inserts == []


# ── Registry-driven graph sources (2026-07-08): pre-built topology-graph queries, all 5 kinds ──────
class TestGraphQueriesAllKinds:
    def test_clickhouse_builds_ready_trace_spans_from_matching_schema(self):
        schema = {"tables": [{"name": "otel_traces", "columns": OTEL_COLUMNS}]}
        c = FakeConn(kind="clickhouse", schema=schema)
        out = dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert len(c.graph_inserts) == 1
        assert c.graph_inserts[0]["st"] == "ready"
        assert out.get("graph_built") == 1 and out.get("graph_ready") == 1

    def test_tempo_builds_ready_trace_spans_whenever_introspected(self):
        c = FakeConn(kind="tempo", schema={"tags": ["service.name"]})
        dsi.run({"integration_id": 7, "kind": "tempo"}, c)
        assert c.graph_inserts and c.graph_inserts[0]["st"] == "ready"

    def test_prometheus_builds_ready_servicegraph_calls_when_metric_present(self):
        c = FakeConn(kind="prometheus", schema={"metrics": ["traces_service_graph_request_total"]})
        dsi.run({"integration_id": 7, "kind": "prometheus"}, c)
        assert c.graph_inserts and c.graph_inserts[0]["st"] == "ready"

    def test_loki_always_builds_two_unavailable_rows(self):
        c = FakeConn(kind="loki", schema={"labels": ["job"]})
        dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert len(c.graph_inserts) == 2
        assert all(p["st"] == "unavailable" for p in c.graph_inserts)

    def test_graph_build_skips_when_hash_unchanged(self):
        c0 = FakeConn(kind="tempo", schema={"tags": []})
        dsi.run({"integration_id": 7, "kind": "tempo"}, c0)
        gversion = c0.graph_inserts[0]["sv"]
        c = FakeConn(kind="tempo", schema={"tags": []}, existing_graph_version=gversion)
        out = dsi.run({"integration_id": 7, "kind": "tempo"}, c)
        assert c.graph_inserts == [] and out.get("graph_skipped") is True

    def test_graph_build_happens_even_when_kind_is_out_of_diag_signal_scope(self):
        # loki is out of diag-signal scope (skipped_kind) but STILL gets pre-built graph-query rows.
        c = FakeConn(kind="loki", schema={"labels": []})
        out = dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert out.get("skipped_kind") == "loki"
        assert c.inserts == []            # no diag signals — out of scope
        assert len(c.graph_inserts) == 2  # but graph queries still built


# ── Live re-introspection (drift detection, 2026-07-08) ─────────────────────────────────────────────
class TestLiveReintrospection:
    def test_drift_detected_updates_schema_cache_and_uses_the_fresh_schema(self, monkeypatch):
        fresh = {"metrics": PROM_METRICS + ["new_metric"], "version": "2.51"}
        monkeypatch.setattr(dsi, "_reintrospect", lambda kind, iid: fresh)
        c = FakeConn(existing_version="STALE")  # cached schema (v2.50) differs from fresh (v2.51)
        out = dsi.run({"integration_id": 7, "kind": "prometheus"}, c)
        assert len(c.schema_writes) == 1
        assert json.loads(c.schema_writes[0]["s"])["version"] == "2.51"
        assert out.get("introspect_error") is None

    def test_no_drift_does_not_rewrite_the_cache(self, monkeypatch):
        same = {"metrics": PROM_METRICS, "version": "2.50"}  # identical to the cached schema
        monkeypatch.setattr(dsi, "_reintrospect", lambda kind, iid: same)
        c = FakeConn(existing_version="STALE")
        dsi.run({"integration_id": 7, "kind": "prometheus"}, c)
        assert c.schema_writes == []

    def test_introspection_failure_falls_back_to_the_cached_schema(self, monkeypatch):
        monkeypatch.setattr(dsi, "_reintrospect", lambda kind, iid: None)
        c = FakeConn(existing_version="STALE")
        out = dsi.run({"integration_id": 7, "kind": "prometheus"}, c)
        assert out.get("introspect_error") == "introspect_failed"
        assert c.schema_writes == []
        assert out.get("built") == 8   # still built, from the cached schema

    def test_no_cache_and_no_kind_and_failed_introspection_is_no_schema(self):
        # default fixture stub (_reintrospect -> None) applies; no kind anywhere to even try with.
        c = FakeConn(schema_present=False)
        out = dsi.run({"integration_id": 7}, c)
        assert out.get("no_schema") is True

    def test_first_ever_run_uses_live_schema_when_no_cache_exists_yet(self, monkeypatch):
        # Brand-new instance: the BFF's warm-cache write hasn't landed (or failed), but the dispatcher
        # still knows the kind from `integrations` — live introspection alone is enough to build.
        fresh = {"tables": [{"name": "otel_traces", "columns": OTEL_COLUMNS}]}
        monkeypatch.setattr(dsi, "_reintrospect", lambda kind, iid: fresh)
        c = FakeConn(kind="clickhouse", schema_present=False)
        out = dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert out.get("no_schema") is not True
        assert len(c.graph_inserts) == 1
        assert len(c.schema_writes) == 1


# ── Hybrid LLM fallback wiring (graph_querygen.py, registry-driven graph sources 2026-07-08) ───────
class TestGraphQuerygenHybridFallback:
    def test_catalog_unavailable_triggers_querygen_and_a_generated_row_wins(self, monkeypatch):
        generated = {"query_key": "trace_spans", "status": "ready",
                     "query": {"tool": "clickhouse_query", "mapper": "otel_v1", "args_template": {"sql": "SELECT 1"}},
                     "missing": None, "meta": {"kind": "clickhouse", "provenance": "generated"}}
        monkeypatch.setattr(dsi._querygen, "try_generate_clickhouse_trace_spans", lambda schema, iid, invoke: generated)
        schema = {"tables": [{"name": "unrelated", "columns": [{"name": "x", "type": "Int64"}]}]}  # no catalog match
        c = FakeConn(kind="clickhouse", schema=schema)
        dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert len(c.graph_inserts) == 1
        assert c.graph_inserts[0]["st"] == "ready"
        assert __import__("json").loads(c.graph_inserts[0]["me"])["provenance"] == "generated"

    def test_querygen_is_never_called_when_the_catalog_already_matched(self, monkeypatch):
        calls = []
        monkeypatch.setattr(dsi._querygen, "try_generate_clickhouse_trace_spans",
                             lambda schema, iid, invoke: calls.append(1))
        schema = {"tables": [{"name": "otel_traces", "columns": OTEL_COLUMNS}]}  # standard shape → catalog ready
        c = FakeConn(kind="clickhouse", schema=schema)
        dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert calls == []  # catalog already ready — no need to ask the model

    def test_querygen_returning_none_leaves_the_catalogs_unavailable_row_in_place(self, monkeypatch):
        monkeypatch.setattr(dsi._querygen, "try_generate_clickhouse_trace_spans", lambda schema, iid, invoke: None)
        schema = {"tables": [{"name": "unrelated", "columns": [{"name": "x", "type": "Int64"}]}]}
        c = FakeConn(kind="clickhouse", schema=schema)
        dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert len(c.graph_inserts) == 1
        assert c.graph_inserts[0]["st"] == "unavailable"

    def test_querygen_never_touched_for_non_clickhouse_kinds(self, monkeypatch):
        calls = []
        monkeypatch.setattr(dsi._querygen, "try_generate_clickhouse_trace_spans",
                             lambda schema, iid, invoke: calls.append(1))
        c = FakeConn(kind="loki", schema={"labels": []})
        dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert calls == []

    def test_a_querygen_exception_never_breaks_the_catalog_based_rebuild(self, monkeypatch):
        def boom(schema, iid, invoke):
            raise RuntimeError("bedrock down")
        monkeypatch.setattr(dsi._querygen, "try_generate_clickhouse_trace_spans", boom)
        schema = {"tables": [{"name": "unrelated", "columns": [{"name": "x", "type": "Int64"}]}]}
        c = FakeConn(kind="clickhouse", schema=schema)
        out = dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert not out.get("error")  # the outer job must not fail
        assert len(c.graph_inserts) == 1 and c.graph_inserts[0]["st"] == "unavailable"
