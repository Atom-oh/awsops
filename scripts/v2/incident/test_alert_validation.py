"""AlertValidation worker: suppression-safety decide() (exhaustive), Haiku fail-closed, prompt
isolation, and lambda_handler orchestration. No AWS/DB — boto3/connector/db all mocked."""
import json
import sys
import types

import pytest

import alert_validation as av


def _snap(**over):
    s = {"id": "a1", "severity": "warning", "source": "alertmanager", "alertName": "HighCPU",
         "services": ["api"], "resources": ["i-1"], "labels": {"team": "x"},
         "metric": {"name": "CPUUtilization", "namespace": "AWS/EC2", "threshold": 90},
         "timestamp": "2026-06-25T00:00:00Z", "account": "123456789012", "alarmArn": None}
    s.update(over)
    return s


FP = {"verdict": "false_positive", "confidence": 0.95}


# ── decide(): the safety-critical core ─────────────────────────────────────────────────────────
def test_decide_suppress_only_when_all_conditions_met():
    assert av.decide(FP, _snap(), 2, False, threshold=0.85, enforce=True) == "suppress"


def test_decide_never_suppresses_critical():
    assert av.decide(FP, _snap(severity="critical"), 5, False, threshold=0.85, enforce=True) == "escalate"


def test_decide_shadow_mode_escalates_even_if_otherwise_suppressible():
    assert av.decide(FP, _snap(), 3, False, threshold=0.85, enforce=False) == "escalate"


def test_decide_insufficient_or_degraded_signals_escalate():
    assert av.decide(FP, _snap(), 1, False, threshold=0.85, enforce=True) == "escalate"   # <2 signals
    assert av.decide(FP, _snap(), 3, True, threshold=0.85, enforce=True) == "escalate"    # a signal failed


def test_decide_non_false_positive_or_low_conf_escalate():
    assert av.decide({"verdict": "real", "confidence": 0.99}, _snap(), 3, False, threshold=0.85, enforce=True) == "escalate"
    assert av.decide({"verdict": "false_positive", "confidence": 0.5}, _snap(), 3, False, threshold=0.85, enforce=True) == "escalate"


def test_decide_no_snapshot_escalates():
    assert av.decide(FP, None, 9, False, threshold=0.85, enforce=True) == "escalate"


def test_suppression_severity_uses_normalized_severity_failclosed_on_unknown():
    assert av.suppression_severity(_snap(severity="critical")) == "critical"
    assert av.suppression_severity(_snap(severity="warning")) == "warning"
    assert av.suppression_severity(_snap(severity="info")) == "info"
    # fail-closed: missing / empty / unknown severity → 'critical' (never silently suppressible)
    assert av.suppression_severity(None) == "critical"
    assert av.suppression_severity(_snap(severity="")) == "critical"
    assert av.suppression_severity(_snap(severity="page")) == "critical"


# ── _haiku_verdict fail-closed + prompt isolation ──────────────────────────────────────────────
class _FakeBody:
    def __init__(self, payload):
        self._b = json.dumps(payload).encode()

    def read(self):
        return self._b


class _FakeBedrock:
    def __init__(self, text=None, raise_exc=False):
        self._text, self._raise = text, raise_exc

    def invoke_model(self, **kw):
        if self._raise:
            raise RuntimeError("bedrock down")
        return {"body": _FakeBody({"content": [{"type": "text", "text": self._text}]})}


def test_haiku_parses_valid_verdict(monkeypatch):
    monkeypatch.setattr(av, "_bedrock", lambda: _FakeBedrock(text='here: {"verdict":"false_positive","confidence":0.9,"propagation":false,"rationale":"transient"}'))
    v = av._haiku_verdict("p")
    assert v["verdict"] == "false_positive" and v["confidence"] == 0.9


def test_haiku_fail_closed_on_exception(monkeypatch):
    monkeypatch.setattr(av, "_bedrock", lambda: _FakeBedrock(raise_exc=True))
    assert av._haiku_verdict("p")["verdict"] == "uncertain"


def test_haiku_fail_closed_on_garbage_or_bad_verdict(monkeypatch):
    monkeypatch.setattr(av, "_bedrock", lambda: _FakeBedrock(text="no json here"))
    assert av._haiku_verdict("p")["verdict"] == "uncertain"
    monkeypatch.setattr(av, "_bedrock", lambda: _FakeBedrock(text='{"verdict":"YES_DROP_IT","confidence":1}'))
    assert av._haiku_verdict("p")["verdict"] == "uncertain"


def test_prompt_redacts_pii_and_excludes_rawpayload():
    snap = _snap(labels={"account_id": "123456789012", "host_ip": "10.1.2.3"})
    snap["rawPayload"] = {"secret": "SHOULD_NOT_APPEAR"}
    prompt = av._build_prompt(snap, [{"source": "tempo", "count": 3}])
    assert "123456789012" not in prompt and "10.1.2.3" not in prompt  # redacted
    assert "SHOULD_NOT_APPEAR" not in prompt                          # rawPayload never included
    assert "untrusted data" in prompt.lower()


# ── lambda_handler orchestration ───────────────────────────────────────────────────────────────
class _FakeConn:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.calls = []

    def run(self, sql, **p):
        self.calls.append((sql, p))
        if "select trigger_event" in " ".join(sql.split()).lower():
            return [[self.snapshot]] if self.snapshot is not None else []
        return []

    def close(self):
        pass


def _patch_handler(monkeypatch, snapshot, bundle, verdict):
    conn = _FakeConn(snapshot)
    monkeypatch.setattr(av.db, "connect", lambda: conn)
    monkeypatch.setattr(av, "collect_signals", lambda c, s: bundle)
    monkeypatch.setattr(av, "_haiku_verdict", lambda prompt: verdict)
    return conn


def test_handler_no_snapshot_escalates(monkeypatch):
    conn = _patch_handler(monkeypatch, None, {"signals": [], "failures": False, "count": 0}, FP)
    r = av.lambda_handler({"incident_id": "inc-1"}, None)
    assert r["decision"] == "escalate" and r["verdict"] == "uncertain"


def test_handler_insufficient_signals_skips_model_and_escalates(monkeypatch):
    conn = _patch_handler(monkeypatch, _snap(), {"signals": [{"source": "topology"}], "failures": False, "count": 1},
                          {"verdict": "false_positive", "confidence": 0.99})
    r = av.lambda_handler({"incident_id": "inc-2"}, None)
    assert r["decision"] == "escalate" and r["verdict"] == "uncertain"


def test_handler_suppress_path_records_false_positive(monkeypatch):
    monkeypatch.setattr(av, "ENFORCE", True, raising=False)
    monkeypatch.setattr(av, "decide", lambda v, s, c, f: "suppress")  # exercised separately above
    conn = _patch_handler(monkeypatch, _snap(), {"signals": [1, 2], "failures": False, "count": 2}, FP)
    r = av.lambda_handler({"incident_id": "inc-3"}, None)
    assert r["decision"] == "suppress"
    upd = [c for c in conn.calls if "update incidents set validation" in " ".join(c[0].split()).lower()]
    assert upd and upd[0][1]["s"] == "false_positive"
    fnd = [c for c in conn.calls if "insert into incident_findings" in " ".join(c[0].split()).lower()]
    assert fnd and fnd[0][1]["id"] == "inc-3"


def test_handler_escalate_path_records_validating(monkeypatch):
    conn = _patch_handler(monkeypatch, _snap(), {"signals": [1, 2], "failures": False, "count": 2},
                          {"verdict": "real", "confidence": 0.9})
    r = av.lambda_handler({"incident_id": "inc-4"}, None)
    assert r["decision"] == "escalate"
    upd = [c for c in conn.calls if "update incidents set validation" in " ".join(c[0].split()).lower()]
    assert upd and upd[0][1]["s"] == "validating"
