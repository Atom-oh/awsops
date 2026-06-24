"""Tests for ai_insights db helpers (pg8000 conn.run pattern)."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db  # noqa: E402


class FakeConn:
    def __init__(self, returns=None):
        self.calls = []
        self._returns = returns or []
    def run(self, sql, **params):
        self.calls.append((sql, params))
        return self._returns.pop(0) if self._returns else []


INSIGHTS = [{"severity": "critical", "title": "OOM", "detail": "api", "source": "k8s", "refs": {}}]


class TestInsert:
    def test_insert_binds_jsonb(self):
        c = FakeConn()
        db.insert_insight(c, status="succeeded", insights=INSIGHTS,
                          sources_used={"k8s": 1}, model="bedrock", error=None)
        sql, p = c.calls[0]
        assert "INSERT INTO ai_insights" in sql and "::jsonb" in sql
        assert p["st"] == "succeeded" and p["md"] == "bedrock"
        assert json.loads(p["ins"])[0]["title"] == "OOM"   # bound, json-encoded
        assert "OOM" not in sql                              # never inlined


class TestGetLatest:
    def test_returns_latest_parsed_with_account_default(self):
        c = FakeConn(returns=[[["succeeded",
                                json.dumps(INSIGHTS), json.dumps({"k8s": 1}), "bedrock", None, "2026-06-24T00:00:00"]]])
        out = db.get_latest_insight(c)
        assert out["status"] == "succeeded"
        assert out["insights"][0]["severity"] == "critical"
        assert out["sources_used"] == {"k8s": 1}
        sql, p = c.calls[0]
        assert "FROM ai_insights" in sql and "ORDER BY generated_at DESC" in sql
        assert p["acct"] == "self"   # default account filter

    def test_returns_none_when_empty(self):
        assert db.get_latest_insight(FakeConn(returns=[[]])) is None

    def test_account_id_param_overridable(self):
        c = FakeConn(returns=[[]])
        db.get_latest_insight(c, account_id="123456789012")
        assert c.calls[0][1]["acct"] == "123456789012"
