"""Tests for the datasource_diag_signals helpers in db.py (pg8000 conn.run pattern).

A FakeConn records (sql, params) and returns canned rows so the helpers are exercised without Aurora.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db  # noqa: E402


class FakeConn:
    def __init__(self, returns=None):
        self.calls = []
        self._returns = returns or []
    def run(self, sql, **params):
        self.calls.append((sql, params))
        return self._returns.pop(0) if self._returns else []


class TestInsertJob:
    """requested_by (round-2 pentest fix): defaults to NULL for internal-only enqueues, but a
    caller acting on behalf of a specific user (schedule_dispatcher.py) must be able to pass it
    through so GET /api/jobs[/id]'s ownership filter doesn't hide the row from its own owner."""

    def test_defaults_requested_by_to_none(self):
        c = FakeConn()
        db.insert_job(c, "j1", "noop", {"a": 1})
        sql, p = c.calls[0]
        assert "requested_by" in sql and p["rb"] is None

    def test_forwards_requested_by(self):
        c = FakeConn()
        db.insert_job(c, "j2", "report", {"a": 1}, requested_by="owner@x.io")
        _sql, p = c.calls[0]
        assert p["rb"] == "owner@x.io"


READY = {"signal_key": "oom_kills", "title": "OOM Kill", "status": "ready",
         "query": {"tool": "prometheus_query", "queries": [{"label": "x", "expr": "up"}]},
         "missing_metrics": None, "meta": {"pillar": "reliability", "threshold": 0}}
UNAVAIL = {"signal_key": "node_disk_usage", "title": "노드 디스크", "status": "unavailable",
           "query": None, "missing_metrics": ["node_filesystem_avail_bytes"],
           "meta": {"pillar": "reliability"}}


class TestUpsert:
    def test_upsert_binds_params_and_jsonb_casts(self):
        c = FakeConn()
        db.upsert_diag_signals(c, 42, [READY, UNAVAIL], "abc123")
        assert len(c.calls) == 2
        for sql, p in c.calls:
            assert "INSERT INTO datasource_diag_signals" in sql
            assert "::jsonb" in sql                       # query/missing_metrics/meta cast
            assert p["iid"] == 42 and p["sv"] == "abc123"
            assert p["sk"] in ("oom_kills", "node_disk_usage")
            # user/structured fields are bound, never inlined
            assert "oom_kills" not in sql and "node_disk_usage" not in sql
        # jsonb payloads are json-encoded strings
        ready_call = next(p for _, p in c.calls if p["sk"] == "oom_kills")
        assert json.loads(ready_call["q"])["tool"] == "prometheus_query"

    def test_upsert_empty_rows_records_a_version_sentinel(self):
        # NOT a no-op: with no row at all there is no schema_version, so read_signal_schema_version()
        # returns None forever and datasource_index rebuilds every run — re-invoking Bedrock daily where
        # the fallback flag is on (review MAJOR). The sentinel remembers "this schema yields nothing".
        c = FakeConn()
        written = db.upsert_diag_signals(c, 1, [], "v")
        assert written == [db.SCHEMA_VERSION_SENTINEL_KEY]
        assert len(c.calls) == 1
        params = c.calls[0][1]
        assert params["sk"] == db.SCHEMA_VERSION_SENTINEL_KEY
        assert params["sv"] == "v"          # the whole point: the version IS recorded
        assert params["st"] == "unavailable"
        assert params["q"] is None          # no query: it is bookkeeping, not a signal

    def test_upsert_returns_written_keys_so_the_sweep_keeps_the_sentinel(self):
        # Sweeping the caller's own rows would delete the sentinel in the same transaction.
        c = FakeConn()
        assert db.upsert_diag_signals(c, 1, [READY], "v") == [READY["signal_key"]]


class TestReadSchemaVersion:
    def test_returns_value_when_rows_present(self):
        c = FakeConn(returns=[[[1, "abc123"]]])
        assert db.read_signal_schema_version(c, 7) == "abc123"
        sql, p = c.calls[0]
        assert "COUNT(DISTINCT schema_version)" in sql and p["iid"] == 7

    def test_does_not_exclude_the_generated_row(self):
        # A version-blind exclusion of the generated row was tried and reverted: for a kind whose
        # deterministic catalog is ALWAYS empty (clickhouse), the generated row can be the ONLY row in the
        # table, and excluding it left zero rows to check — reading as no version forever and regenerating
        # on every single call (review, this round). Staleness after a sweep-spared read failure is instead
        # resolved by touch_generated_signal_version(), which brings the row back into agreement without
        # needing to read or preserve its content.
        c = FakeConn(returns=[[[1, "abc123"]]])
        db.read_signal_schema_version(c, 7)
        sql, _ = c.calls[0]
        assert "generated_signal" not in sql

class TestTouchGeneratedSignalVersion:
    def test_updates_only_the_version_column_for_the_fixed_key(self):
        # Exists so a sweep-spared (unverified) generated row's version can be brought back into agreement
        # with the rest of the table WITHOUT touching content we never read — the version-blind EXCLUSION
        # approach tried first broke the opposite way: excluding the generated key left a clickhouse-only
        # (deterministic catalog always empty) build with zero rows to check, reading as no version forever
        # and regenerating on every single call (review, this round).
        c = FakeConn()
        db.touch_generated_signal_version(c, 7, "newversion")
        sql, p = c.calls[0]
        assert sql.strip().startswith("UPDATE datasource_diag_signals")
        assert "signal_key='generated_signal'" in sql
        assert p == {"iid": 7, "sv": "newversion"}


class TestDiagSignalBudget:
    """The weekly-retry marker used to share a column with the content rows' schema_version. Every fix
    that protected the budget's own identity (a preserved stale marker, an excluded key) ended up tagging
    fresh CONTENT with a version that didn't describe it — so a schema that later rolled back to whatever
    that stale tag actually named made the agreement check see a false match and skip, serving newer,
    mistagged content as the old schema's real signals (review, this round). Storing the marker in a
    dedicated row's `meta` field, never in any row's `schema_version`, means content is always free to
    carry the truth; read_diag_signal_budget() reads it back independent of schema_version entirely."""

    def test_read_returns_none_when_the_row_is_absent(self):
        c = FakeConn(returns=[[]])
        assert db.read_diag_signal_budget(c, 7) is None

    def test_read_extracts_the_budget_field_from_meta(self):
        c = FakeConn(returns=[[[json.dumps({"budget": "hash:pend1w202601"})]]])
        assert db.read_diag_signal_budget(c, 7) == "hash:pend1w202601"

    def test_read_queries_the_fixed_bookkeeping_key_only(self):
        c = FakeConn(returns=[[]])
        db.read_diag_signal_budget(c, 7)
        sql, p = c.calls[0]
        assert "signal_key" in sql and p == {"iid": 7, "sk": db.BUDGET_KEY}

    def test_the_budget_key_is_not_a_real_schema_hash(self):
        # It must never collide with an actual content row's key, and must be excluded from the BFF read
        # path the same way __schema_version__ is (it is bookkeeping, not a signal).
        assert db.BUDGET_KEY != db.SCHEMA_VERSION_SENTINEL_KEY
        assert db.BUDGET_KEY.startswith("__") and db.BUDGET_KEY.endswith("__")

    def test_returns_none_when_absent(self):
        c = FakeConn(returns=[[[0, None]]])
        assert db.read_signal_schema_version(c, 7) is None

    def test_returns_none_when_versions_are_mixed(self):
        c = FakeConn(returns=[[[2, "newest"]]])
        assert db.read_signal_schema_version(c, 7) is None


class TestList:
    def test_list_returns_parsed_rows(self):
        c = FakeConn(returns=[[
            ["oom_kills", "OOM Kill", "ready",
             json.dumps({"tool": "prometheus_query", "queries": [{"label": "x", "expr": "up"}]}),
             None, json.dumps({"pillar": "reliability", "threshold": 0})],
            ["node_disk_usage", "노드 디스크", "unavailable",
             None, json.dumps(["node_filesystem_avail_bytes"]), json.dumps({"pillar": "reliability"})],
        ]])
        rows = db.list_diag_signals(c, 9)
        by = {r["signal_key"]: r for r in rows}
        assert by["oom_kills"]["status"] == "ready"
        assert by["oom_kills"]["query"]["tool"] == "prometheus_query"
        assert by["node_disk_usage"]["missing_metrics"] == ["node_filesystem_avail_bytes"]
        assert "WHERE account_id" in c.calls[0][0] and c.calls[0][1]["iid"] == 9


class TestSweep:
    def test_sweep_deletes_keys_not_kept_bound(self):
        c = FakeConn()
        db.sweep_diag_signals(c, 5, ["oom_kills", "cpu_saturation"])
        sql, p = c.calls[0]
        assert "DELETE FROM datasource_diag_signals" in sql
        assert p["iid"] == 5 and p["keep"] == ["oom_kills", "cpu_saturation"]
        assert "oom_kills" not in sql  # bound, not inlined

    def test_sweep_empty_keep_deletes_all_for_instance(self):
        c = FakeConn()
        db.sweep_diag_signals(c, 5, [])
        sql, p = c.calls[0]
        assert "DELETE FROM datasource_diag_signals" in sql and p["iid"] == 5


# ── datasource_graph_queries (pre-built topology-graph queries) ─────────────────────────────────
GQ_READY = {"query_key": "trace_spans", "status": "ready",
            "query": {"tool": "clickhouse_query", "mapper": "otel_v1", "args_template": {"sql": "SELECT 1"}},
            "missing": None, "meta": {"kind": "clickhouse", "provenance": "catalog"}}
GQ_UNAVAIL = {"query_key": "servicegraph_calls", "status": "unavailable", "query": None,
              "missing": ["istio_requests_total"], "meta": {"kind": "prometheus", "provenance": "catalog"}}


class TestUpsertGraphQueries:
    def test_upsert_binds_params_and_jsonb_casts(self):
        c = FakeConn()
        db.upsert_graph_queries(c, 42, [GQ_READY, GQ_UNAVAIL], "abc123")
        assert len(c.calls) == 2
        for sql, p in c.calls:
            assert "INSERT INTO datasource_graph_queries" in sql
            assert "::jsonb" in sql
            assert p["iid"] == 42 and p["sv"] == "abc123"
            assert p["qk"] in ("trace_spans", "servicegraph_calls")
            assert "trace_spans" not in sql and "servicegraph_calls" not in sql  # bound, not inlined
        ready_call = next(p for _, p in c.calls if p["qk"] == "trace_spans")
        assert json.loads(ready_call["q"])["mapper"] == "otel_v1"

    def test_upsert_empty_rows_is_noop(self):
        c = FakeConn()
        db.upsert_graph_queries(c, 1, [], "v")
        assert c.calls == []


class TestReadGraphSchemaVersion:
    def test_returns_value_when_rows_present(self):
        c = FakeConn(returns=[[[1, "abc123"]]])
        assert db.read_graph_schema_version(c, 7) == "abc123"
        sql, p = c.calls[0]
        assert "COUNT(DISTINCT schema_version)" in sql and "datasource_graph_queries" in sql
        assert p["iid"] == 7

    def test_returns_none_when_absent(self):
        c = FakeConn(returns=[[[0, None]]])
        assert db.read_graph_schema_version(c, 7) is None

    def test_returns_none_when_versions_are_mixed(self):
        c = FakeConn(returns=[[[2, "newest"]]])
        assert db.read_graph_schema_version(c, 7) is None


class TestSweepGraphQueries:
    def test_sweep_deletes_keys_not_kept_bound(self):
        c = FakeConn()
        db.sweep_graph_queries(c, 5, ["trace_spans"])
        sql, p = c.calls[0]
        assert "DELETE FROM datasource_graph_queries" in sql
        assert p["iid"] == 5 and p["keep"] == ["trace_spans"]

    def test_sweep_empty_keep_deletes_all_for_instance(self):
        c = FakeConn()
        db.sweep_graph_queries(c, 5, [])
        sql, p = c.calls[0]
        assert "DELETE FROM datasource_graph_queries" in sql and p["iid"] == 5


class TestUpsertDatasourceSchema:
    """Write-back of a freshly re-introspected schema (drift refresh) — python-worker side mirror
    of the BFF's upsertSchema (web/lib/datasource-schema.ts), used only by datasource_index.py."""
    def test_upsert_binds_params_and_jsonb_casts(self):
        c = FakeConn()
        db.upsert_datasource_schema(c, "self", 42, "clickhouse", {"version": "1.2", "tables": []})
        assert len(c.calls) == 1
        sql, p = c.calls[0]
        assert "INSERT INTO datasource_schemas" in sql and "::jsonb" in sql
        assert p["acct"] == "self" and p["iid"] == 42 and p["k"] == "clickhouse"
        assert json.loads(p["s"]) == {"version": "1.2", "tables": []}
