"""card_catalog.build_cards — deterministic dashboard-card matching per connector kind."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import card_catalog as cc  # noqa: E402


def test_prometheus_ready_and_unavailable_split():
    schema = {"metrics": ["up", "node_cpu_seconds_total"], "labels": []}
    rows = cc.build_cards("prometheus", schema)
    by = {r["card_key"]: r for r in rows}
    assert by["up_targets"]["status"] == "ready"
    assert by["up_targets"]["query"]["tool"] == "prometheus_query"
    assert by["cpu_usage"]["status"] == "ready"
    assert by["memory_available"]["status"] == "unavailable"
    assert "node_memory_MemAvailable_bytes" in by["memory_available"]["missing"]
    # ready timeseries cards carry a stored range
    assert by["cpu_usage"]["query"]["range"] == {"window": 3600, "step": 60}
    # unavailable cards carry no query at all
    assert by["memory_available"]["query"] is None


def test_mimir_uses_mimir_tool():
    rows = cc.build_cards("mimir", {"metrics": ["up"], "labels": []})
    by = {r["card_key"]: r for r in rows}
    assert by["up_targets"]["query"]["tool"] == "mimir_query"


def test_loki_anchor_label_fallback():
    rows = cc.build_cards("loki", {"labels": ["app"]})
    by = {r["card_key"]: r for r in rows}
    assert by["log_volume"]["status"] == "ready"
    assert '{app=~".+"}' in by["log_volume"]["query"]["expr"]
    none = {r["card_key"]: r for r in cc.build_cards("loki", {"labels": ["whatever"]})}
    assert none["log_volume"]["status"] == "unavailable"
    assert set(none["log_volume"]["missing"]) == {"job", "app", "namespace"}


def test_tempo_always_ready():
    rows = cc.build_cards("tempo", {"tags": []})
    assert all(r["status"] == "ready" for r in rows)
    assert {r["card_key"] for r in rows} == {"slow_traces", "error_traces"}


def test_clickhouse_table_resolution_and_identifier_guard():
    good = {"tables": [{"name": "otel_traces", "columns": [{"name": "Timestamp"}, {"name": "TraceId"}, {"name": "ServiceName"}]}]}
    by = {r["card_key"]: r for r in cc.build_cards("clickhouse", good)}
    assert by["otel_span_rate"]["status"] == "ready"
    assert "FROM otel_traces" in by["otel_span_rate"]["query"]["expr"]
    assert by["top_services"]["status"] == "ready"
    # heuristic fallback: Timestamp+TraceId columns, non-otel name
    heur = {"tables": [{"name": "spans_v2", "columns": [{"name": "Timestamp"}, {"name": "TraceId"}]}]}
    by2 = {r["card_key"]: r for r in cc.build_cards("clickhouse", heur)}
    assert "FROM spans_v2" in by2["otel_span_rate"]["query"]["expr"]
    assert by2["top_services"]["status"] == "unavailable"  # no ServiceName column
    # a table name failing the identifier charset is NEVER spliced
    evil = {"tables": [{"name": "otel_traces; DROP TABLE x", "columns": [{"name": "Timestamp"}, {"name": "TraceId"}]}]}
    by3 = {r["card_key"]: r for r in cc.build_cards("clickhouse", evil)}
    assert by3["otel_span_rate"]["status"] == "unavailable"


def test_unknown_kind_and_missing_schema():
    assert cc.build_cards("jaeger", {"tags": []}) == []
    assert cc.build_cards("prometheus", None) == []


def test_purity_no_forbidden_imports():
    import inspect
    src = inspect.getsource(cc)
    for banned in ("boto3", "urllib", "requests", "pg8000", "psycopg"):
        assert banned not in src
