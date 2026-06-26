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


def test_decide_escalates_on_nonfinite_or_oob_confidence():
    # M3 defense-in-depth: NaN < threshold is False, so a non-finite confidence would otherwise
    # slip past the gate. The safety core must fail-closed on anything not finite-in-[0,1].
    nan, inf = float("nan"), float("inf")
    assert av.decide({"verdict": "false_positive", "confidence": nan}, _snap(), 3, False, threshold=0.85, enforce=True) == "escalate"
    assert av.decide({"verdict": "false_positive", "confidence": inf}, _snap(), 3, False, threshold=0.85, enforce=True) == "escalate"
    assert av.decide({"verdict": "false_positive", "confidence": 999}, _snap(), 3, False, threshold=0.85, enforce=True) == "escalate"


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


def test_haiku_fail_closed_on_nonfinite_or_oob_confidence(monkeypatch):
    # M3: json.loads accepts NaN/Infinity; a false_positive with a non-finite or out-of-[0,1]
    # confidence must fail closed to 'uncertain' (never trusted as a high-confidence suppression).
    for bad in ("NaN", "Infinity", "-Infinity", "999", "-0.5"):
        monkeypatch.setattr(av, "_bedrock",
                            lambda b=bad: _FakeBedrock(text='{"verdict":"false_positive","confidence":%s}' % b))
        assert av._haiku_verdict("p")["verdict"] == "uncertain"


class _FakeCW:
    def __init__(self, values):
        self._values = values

    def get_metric_data(self, **kw):
        return {"MetricDataResults": [{"Values": list(self._values)}]}


def test_cloudwatch_zero_datapoints_is_not_a_signal(monkeypatch):
    # M2: an empty metric window (datapoints=0) is ABSENT corroboration, not a signal — counting
    # it could satisfy the >=2-signal suppression gate with empty data.
    snap = _snap(metric={"name": "CPUUtilization", "namespace": "AWS/EC2", "threshold": 90})
    monkeypatch.setattr(av.boto3, "client", lambda *a, **k: _FakeCW([]))
    sig, failed = av._cloudwatch_signal(snap)
    assert sig is None and failed is False                # absent, NOT a failure
    monkeypatch.setattr(av.boto3, "client", lambda *a, **k: _FakeCW([1.0, 2.0]))
    sig, failed = av._cloudwatch_signal(snap)
    assert sig is not None and sig["datapoints"] == 2 and failed is False


def test_datasource_empty_summary_not_counted_failed_invoke_is_failure(monkeypatch):
    # M2: empty/unrecognized result is NOT corroboration; a failing invoke (incl. FunctionError →
    # 502 from connector_invoke) IS a signal failure → fail-closed escalate.
    monkeypatch.setattr(av, "_remaining", lambda start, deadline_s=0.0: 100.0)

    class _C:
        def run(self, sql, **p):
            return [[1, "loki"]]   # one discovered datasource instance

    monkeypatch.setattr(av.connector_invoke, "invoke_connector", lambda *a, **k: (200, {}))
    out, failures = av._datasource_signals(_C(), 0.0)
    assert out == [] and failures is False                # empty summary → absent, not a failure

    monkeypatch.setattr(av.connector_invoke, "invoke_connector", lambda *a, **k: (502, {}))
    out, failures = av._datasource_signals(_C(), 0.0)
    assert out == [] and failures is True                 # 502 (FunctionError/missing status) → failure

    monkeypatch.setattr(av.connector_invoke, "invoke_connector", lambda *a, **k: (200, {"result": [1, 2]}))
    out, failures = av._datasource_signals(_C(), 0.0)
    assert len(out) == 1 and failures is False            # grounded result → counted


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
    monkeypatch.setattr(av, "collect_signals", lambda c, s, **kw: bundle)
    monkeypatch.setattr(av, "_haiku_verdict", lambda prompt: verdict)
    monkeypatch.setattr(av, "_ssm", lambda: None)  # no real AWS
    monkeypatch.setattr(av, "read_tunables",
                        lambda ssm: {"deadline_s": av.DEADLINE_S, "confidence_threshold": av.CONF_THRESHOLD,
                                     "enforce": av.ENFORCE})
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
    monkeypatch.setattr(av, "decide", lambda v, s, c, f, **kw: "suppress")  # exercised separately above
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


class _FakeSSM:
    def __init__(self, values):       # {suffix: value-string}
        self._v = values

    def get_parameter(self, Name):
        for suffix, val in self._v.items():
            if Name.endswith(suffix):
                return {"Parameter": {"Value": val}}
        raise RuntimeError("ParameterNotFound: " + Name)


def test_read_tunables_coercion_and_degrade_safe():
    # FF-A: live values coerced (float deadline/threshold, bool enforce)
    t = av.read_tunables(_FakeSSM({"validation-deadline-s": "40", "suppress-confidence-threshold": "0.9",
                                   "suppression-enforce": "true"}))
    assert t["deadline_s"] == 40.0 and t["confidence_threshold"] == 0.9 and t["enforce"] is True
    # missing params → env/module defaults (degrade-safe, like read_caps)
    t2 = av.read_tunables(_FakeSSM({}))
    assert t2["deadline_s"] == av.DEADLINE_S and t2["confidence_threshold"] == av.CONF_THRESHOLD \
        and t2["enforce"] == av.ENFORCE
    # garbage / non-finite float → default; any non-'true' enforce → False (fail-safe to shadow)
    t3 = av.read_tunables(_FakeSSM({"validation-deadline-s": "NaN", "suppress-confidence-threshold": "xyz",
                                    "suppression-enforce": "FALSE"}))
    assert t3["deadline_s"] == av.DEADLINE_S and t3["confidence_threshold"] == av.CONF_THRESHOLD \
        and t3["enforce"] is False


def test_read_tunables_clamps_out_of_range_to_default():
    # FF-A re-review MAJOR: confidence-threshold must be (0,1] — 0/negative would suppress
    # arbitrarily-low-confidence verdicts (false-negative); >1 abnormal. Out-of-range → default.
    for bad in ("0", "-0.2", "1.5", "Infinity"):
        assert av.read_tunables(_FakeSSM({"suppress-confidence-threshold": bad}))["confidence_threshold"] \
            == av.CONF_THRESHOLD
    # deadline must be (0, MAX]; 0/negative/oversized → default
    for bad in ("0", "-5", "100000"):
        assert av.read_tunables(_FakeSSM({"validation-deadline-s": bad}))["deadline_s"] == av.DEADLINE_S
    # in-range values are honored
    t = av.read_tunables(_FakeSSM({"suppress-confidence-threshold": "0.5", "validation-deadline-s": "10"}))
    assert t["confidence_threshold"] == 0.5 and t["deadline_s"] == 10.0


def test_handler_degrades_to_defaults_when_ssm_unavailable(monkeypatch):
    # FF-A re-review suggestion: _ssm() build / read failure must NOT crash the handler (the
    # outer try/except in lambda_handler falls back to module defaults). Real verdict → escalate.
    conn = _patch_handler(monkeypatch, _snap(), {"signals": [1, 2], "failures": False, "count": 2},
                          {"verdict": "real", "confidence": 0.9})
    monkeypatch.setattr(av, "_ssm", lambda: (_ for _ in ()).throw(RuntimeError("no creds")))
    assert av.lambda_handler({"incident_id": "inc-degrade"}, None)["decision"] == "escalate"


def test_handler_live_ssm_enforce_drives_suppression(monkeypatch):
    # FF-A safety knob: SSM enforce='true' flips shadow→enforce WITHOUT redeploy. Same suppressible
    # inputs suppress when SSM says enforce, and escalate (shadow) when it doesn't.
    conn = _patch_handler(monkeypatch, _snap(severity="warning"),
                          {"signals": [1, 2], "failures": False, "count": 2}, FP)
    monkeypatch.setattr(av, "read_tunables",
                        lambda ssm: {"deadline_s": 25.0, "confidence_threshold": 0.85, "enforce": True})
    assert av.lambda_handler({"incident_id": "inc-live-on"}, None)["decision"] == "suppress"

    conn = _patch_handler(monkeypatch, _snap(severity="warning"),
                          {"signals": [1, 2], "failures": False, "count": 2}, FP)
    monkeypatch.setattr(av, "read_tunables",
                        lambda ssm: {"deadline_s": 25.0, "confidence_threshold": 0.85, "enforce": False})
    assert av.lambda_handler({"incident_id": "inc-live-off"}, None)["decision"] == "escalate"


def test_handler_live_ssm_threshold_gates_suppression(monkeypatch):
    # A live threshold above the verdict confidence (FP=0.95) escalates even with enforce=true.
    conn = _patch_handler(monkeypatch, _snap(severity="warning"),
                          {"signals": [1, 2], "failures": False, "count": 2}, FP)
    monkeypatch.setattr(av, "read_tunables",
                        lambda ssm: {"deadline_s": 25.0, "confidence_threshold": 0.99, "enforce": True})
    assert av.lambda_handler({"incident_id": "inc-thr"}, None)["decision"] == "escalate"


def test_datasource_deadline_exhaustion_is_failclosed(monkeypatch):
    # If the global deadline is exhausted mid datasource-collection, fail-closed (failures=True)
    # so the suppression gate escalates rather than acting on partial signals.
    monkeypatch.setattr(av, "_remaining", lambda start, deadline_s=0.0: -1.0)

    class _C:
        def run(self, sql, **p):
            return [[1, "tempo"]]  # one discovered datasource instance

    out, failures = av._datasource_signals(_C(), 0.0)
    assert failures is True
    assert out == []
