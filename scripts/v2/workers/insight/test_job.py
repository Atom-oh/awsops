"""Tests for insight.job.run — gate, collect→synthesize→store, partial/failed handling, never-raise."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from insight import job, cost_anomalies, cw_anomalies, k8s_events, generate  # noqa: E402


class FakeConn:
    def __init__(self):
        self.inserts = []
    def run(self, sql, **p):
        if sql.strip().startswith("INSERT INTO ai_insights"):
            self.inserts.append(p)
        return []


def _stub(monkeypatch, k8s=None, cw=None, cost=None, synth=None):
    monkeypatch.setenv("AI_INSIGHTS_ENABLED", "true")
    monkeypatch.setattr(k8s_events, "collect_k8s_events", k8s or (lambda: {"source": "k8s", "items": [], "notes": ""}))
    monkeypatch.setattr(cw_anomalies, "collect_cw_anomalies", cw or (lambda cw_client=None: {"source": "cloudwatch", "items": [], "notes": ""}))
    monkeypatch.setattr(cost_anomalies, "collect_cost_anomalies", cost or (lambda ce=None: {"source": "cost", "items": [], "notes": ""}))
    if synth:
        monkeypatch.setattr(generate, "synthesize", synth)


class TestGate:
    def test_disabled_when_flag_off(self, monkeypatch):
        monkeypatch.delenv("AI_INSIGHTS_ENABLED", raising=False)
        c = FakeConn()
        out = job.run({}, c)
        assert out.get("disabled") is True and c.inserts == []


class TestHappy:
    def test_collect_synthesize_store(self, monkeypatch):
        _stub(monkeypatch,
              k8s=lambda: {"source": "k8s", "items": [{"severity": "critical", "title": "OOM"}], "notes": ""},
              synth=lambda signals, **kw: {"status": "succeeded", "model": "bedrock",
                                           "insights": [{"severity": "critical", "title": "OOM in prod"}]})
        c = FakeConn()
        out = job.run({}, c)
        assert out["status"] == "succeeded" and len(c.inserts) == 1
        assert c.inserts[0]["st"] == "succeeded"
        import json
        assert json.loads(c.inserts[0]["src"])["k8s"] == 1   # sources_used count


class TestDegraded:
    def test_partial_collector_failure_still_proceeds(self, monkeypatch):
        def boom():
            raise RuntimeError("k8s down")
        _stub(monkeypatch, k8s=boom,
              cost=lambda ce=None: {"source": "cost", "items": [{"severity": "warning", "title": "EC2"}], "notes": ""},
              synth=lambda signals, **kw: {"status": "succeeded", "model": "bedrock", "insights": [{"severity": "warning", "title": "x"}]})
        c = FakeConn()
        out = job.run({}, c)
        assert out["status"] == "succeeded" and len(c.inserts) == 1   # one collector failed, run continued

    def test_all_collectors_fail_marks_failed(self, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("egress down")
        _stub(monkeypatch, k8s=boom, cw=boom, cost=boom)
        c = FakeConn()
        out = job.run({}, c)
        assert out["status"] == "failed" and c.inserts[0]["st"] == "failed"

    def test_never_raises_on_store_error(self, monkeypatch):
        _stub(monkeypatch, synth=lambda signals, **kw: {"status": "succeeded", "model": None, "insights": []})
        class BadConn:
            def run(self, sql, **p):
                raise RuntimeError("db down")
        out = job.run({}, BadConn())
        assert "error" in out or out.get("status")   # surfaced, not raised
