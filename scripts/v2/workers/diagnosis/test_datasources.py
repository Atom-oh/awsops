import io
import json

from diagnosis import sources as src


class FakeConn:
    """Routes by SQL: the integrations discovery query → `instances`; the schema query → schemas[iid]."""
    def __init__(self, instances, schemas=None, raise_on=None):
        self.instances = instances
        self.schemas = schemas or {}
        self.raise_on = raise_on

    def run(self, sql, **kw):
        if self.raise_on and self.raise_on in sql:
            raise RuntimeError("boom")
        if "FROM integrations" in sql:
            return self.instances
        if "FROM datasource_schemas" in sql:
            s = self.schemas.get(kw.get("iid"))
            return [[s]] if s is not None else []
        return []


class FakeLambda:
    """Captures invoke payloads; returns a fixed connector envelope {statusCode, body(JSON str)}."""
    def __init__(self, body=None, status=200):
        self.calls = []
        self.body = body if body is not None else {"result": {"shape": "vector", "series": [{"v": 1}]}}
        self.status = status

    def invoke(self, FunctionName, Payload):
        self.calls.append({"fn": FunctionName, "payload": json.loads(Payload)})
        env = json.dumps({"statusCode": self.status, "body": json.dumps(self.body)}).encode("utf-8")
        return {"Payload": io.BytesIO(env)}


def _patch_lambda(monkeypatch, fake):
    monkeypatch.setattr(src, "_lambda_client", lambda: fake)
    return fake


# A2 — credential-blind: the worker sends ONLY instance_id, NEVER conn_config/credentials.
def test_invoke_is_credential_blind(monkeypatch):
    fake = _patch_lambda(monkeypatch, FakeLambda())
    conn = FakeConn([(5, "prod-prom", "prometheus", True)],
                    {5: {"version": "2.48.0", "metrics": ["http_requests_total", "node_cpu_seconds_total"]}})
    out = src.collect_datasources(conn)
    assert out["key"] == "datasources" and out["ok"]
    assert fake.calls, "connector should have been invoked"
    for c in fake.calls:
        assert c["fn"] == "awsops-v2-agent-prometheus-mcp"
        args = c["payload"]["arguments"]
        assert args["instance_id"] == 5                       # per-instance routing
        assert "conn_config" not in c["payload"]              # credential-blind
        assert not any(k in args for k in ("password", "token", "username", "endpoint"))


# A3 — schema-driven: query NAMES come from the cached schema, signal-matched, aggregated.
def test_plan_is_schema_driven_and_aggregated(monkeypatch):
    fake = _patch_lambda(monkeypatch, FakeLambda())
    conn = FakeConn([(5, "p", "prometheus", True)],
                    {5: {"metrics": ["http_requests_total", "go_gc_duration_seconds", "unrelated_gauge"]}})
    src.collect_datasources(conn)
    queries = [c["payload"]["arguments"]["query"] for c in fake.calls]
    assert any("http_requests_total" in q and "rate(" in q for q in queries)   # counter → rate()
    assert all("unrelated_gauge" not in q for q in queries)                    # non-signal series skipped
    assert all(q.startswith("topk(") for q in queries)                         # bounded/aggregated


# A6 — caps: default takes is_default only (MAX_INSTANCES_PER_KIND=1); ≤MAX_QUERIES_PER_INSTANCE.
def test_caps_default_instance_and_query_budget(monkeypatch):
    fake = _patch_lambda(monkeypatch, FakeLambda())
    conn = FakeConn(
        [(5, "default-prom", "prometheus", True), (6, "stg-prom", "prometheus", False)],  # ORDER BY is_default DESC
        {5: {"metrics": [f"errors_total_{i}" for i in range(10)]}, 6: {"metrics": ["errors_total_x"]}},
    )
    src.collect_datasources(conn)
    invoked_instances = {c["payload"]["arguments"]["instance_id"] for c in fake.calls}
    assert invoked_instances == {5}                                  # only the default instance
    assert len(fake.calls) <= src._DS_MAX_QUERIES_PER_INSTANCE        # query budget per instance


# A6b — an instance with no cached schema is skipped with an explicit note (never invoked).
def test_no_cache_row_skipped_with_note(monkeypatch):
    fake = _patch_lambda(monkeypatch, FakeLambda())
    conn = FakeConn([(9, "fresh-prom", "prometheus", True)], {})  # no schema cached
    out = src.collect_datasources(conn)
    assert fake.calls == []                                          # nothing queried
    assert any("Refresh schema" in n for n in out["data"].get("notes", []))


# A4/A5 — summarize-before-LLM: compact shape, and the data blob stays under the byte cap.
def test_summarize_and_byte_cap(monkeypatch):
    big = {"result": {"shape": "matrix", "series": [{"v": i} for i in range(1000)]}}
    _patch_lambda(monkeypatch, FakeLambda(body=big))
    conn = FakeConn([(5, "p", "prometheus", True)], {5: {"metrics": ["request_errors_total"]}})
    out = src.collect_datasources(conn)
    assert len(json.dumps(out["data"])) <= src._DS_MAX_BYTES + 200    # bounded (cap + small envelope)


# never-raises: a DB failure degrades, it does not throw.
def test_db_failure_degrades_not_raises(monkeypatch):
    conn = FakeConn([], raise_on="FROM integrations")
    out = src.collect_datasources(conn)
    assert out["key"] == "datasources" and out["degraded"] and not out["ok"]


# empty: no datasources configured → ok, empty, explicit note.
def test_no_datasources(monkeypatch):
    out = src.collect_datasources(FakeConn([]))
    assert out["ok"] and out["data"]["queried"] == 0
