"""Tests for diagnosis source collectors — inventory detail + cw_metrics instance lookup.
Worker uses pg8000 conn.run(sql, **named_params) → list of row tuples. No live AWS/DB."""
import json
import os
import sys
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import sources as src  # noqa: E402


class FakeConn:
    """Routes by SQL substring → rows (list or callable(kw)->list). Records queries for assertions."""
    def __init__(self, routes=None, raise_on=None):
        self.routes = routes or {}
        self.raise_on = raise_on
        self.queries = []

    def run(self, sql, **kw):
        self.queries.append((sql, kw))
        if self.raise_on and self.raise_on in sql:
            raise RuntimeError("boom")
        for sub, rows in self.routes.items():
            if sub in sql:
                return rows(kw) if callable(rows) else rows
        return []

    def sqls(self):
        return " || ".join(q[0] for q in self.queries)


class _FakeCW:
    def __init__(self):
        self.last = None

    def get_metric_data(self, **kw):
        self.last = kw
        # one Average value per requested cpu{i}
        return {"MetricDataResults": [{"Id": q["Id"], "Values": [12.5]} for q in kw["MetricDataQueries"]]}


# ── Task 1: collect_cw_metrics instance lookup ──────────────────────────────────
class TestCwMetrics:
    def test_finds_ec2_instances_and_queries_metrics(self):
        conn = FakeConn(routes={"resource_id FROM inventory_resources": [["i-aaa"], ["i-bbb"]]})
        cw = _FakeCW()
        with mock.patch.object(src, "_cw_client", return_value=cw):
            out = src.collect_cw_metrics(conn)
        # the lookup must scope to the REAL synced type 'ec2' (not the never-matching 'ec2_instance')
        assert "resource_type = 'ec2'" in conn.sqls()
        assert "account_id = 'self'" in conn.sqls()
        assert out["ok"] and "i-aaa" in out["data"]["by_instance"]
        assert out["data"]["avg_cpu"] == 12.5

    def test_no_ec2_degrades_to_empty(self):
        conn = FakeConn(routes={})  # no rows
        out = src.collect_cw_metrics(conn)
        assert out["data"] == {"by_instance": {}, "avg_cpu": None}
        assert "no ec2 instance ids" in out["notes"]

    def test_never_raises_on_db_error(self):
        conn = FakeConn(routes={}, raise_on="resource_id FROM inventory_resources")
        out = src.collect_cw_metrics(conn)  # must not raise
        assert out["data"]["by_instance"] == {}
