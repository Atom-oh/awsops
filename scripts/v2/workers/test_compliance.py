"""compliance.py — Powerpipe JSON parsing (pure), password scrub, and the _compliance handler
registration/dry_run. No subprocess/boto3/Aurora in these tests."""
import compliance
import handlers

# Top-level group rollup summary (v1 parity: run totals come from groups[].summary.control),
# plus leaf control results (for compliance_results detail rows).
SAMPLE = {
    "groups": [
        {
            "title": "1 IAM",
            "summary": {"control": {"total": 2, "ok": 1, "alarm": 1, "info": 0, "skip": 0, "error": 0}},
            "controls": [
                {"control_id": "1.1", "title": "MFA", "description": "Enable MFA for all IAM users with a console password.", "tags": {"severity": "high"}, "results": [
                    {"status": "ok", "reason": "ok", "resource": "arn:user/a",
                     "dimensions": [{"key": "region", "value": "us-east-1"}]},
                    {"status": "alarm", "reason": "no mfa", "resource": "arn:user/b",
                     "dimensions": [{"key": "region", "value": "us-east-1"}]},
                ]},
            ],
        },
    ],
}


def test_parse_totals_from_group_summaries():
    totals, controls = compliance.parse_powerpipe_json(SAMPLE)
    assert totals["total_controls"] == 2 and totals["ok"] == 1 and totals["alarm"] == 1
    assert round(totals["pass_rate"], 1) == 50.0  # ok / (ok+alarm+info+skip+error) * 100
    assert sorted(c["status"] for c in controls) == ["alarm", "ok"]
    assert all(c["region"] == "us-east-1" for c in controls)
    assert controls[0]["severity"] == "high"
    # Gap L70: the control description (recommendation rationale) rides every leaf result row.
    assert all(c["description"] == "Enable MFA for all IAM users with a console password." for c in controls)


def test_parse_missing_description_defaults_to_empty():
    doc = {"groups": [{"title": "g", "controls": [
        {"control_id": "x", "title": "t", "results": [{"status": "ok", "reason": "", "resource": "r"}]},
    ]}]}
    _, controls = compliance.parse_powerpipe_json(doc)
    assert controls[0]["description"] == ""


def test_parse_empty_is_zero_not_crash():
    totals, controls = compliance.parse_powerpipe_json({"groups": []})
    assert totals["total_controls"] == 0 and totals["pass_rate"] == 0
    assert controls == []


def test_parse_falls_back_to_leaf_counts_when_no_summary():
    doc = {"groups": [{"title": "g", "controls": [
        {"control_id": "x", "results": [{"status": "ok"}, {"status": "alarm"}, {"status": "ok"}]}]}]}
    totals, controls = compliance.parse_powerpipe_json(doc)
    assert totals["total_controls"] == 3 and totals["ok"] == 2 and totals["alarm"] == 1
    assert len(controls) == 3


def test_scrub_redacts_steampipe_password():
    msg = "FATAL: connect postgres://steampipe:s3cr3tPW@host:9193/steampipe failed"
    scrubbed = compliance._scrub(msg)
    assert "s3cr3tPW" not in scrubbed
    assert "postgres://steampipe:***@host" in scrubbed


def test_compliance_handler_dry_run():
    out, art = handlers._compliance({"benchmark": "cis_v300", "run_id": 1}, True)
    assert out["dry_run"] is True and out["would_run"] == "cis_v300"
    assert art is None


def test_compliance_registered_as_fargate():
    assert handlers.REGISTRY["compliance"][1] == "fargate"
    assert handlers.is_allowed("compliance")
    assert handlers.runtime_for("compliance") == "fargate"


def test_run_powerpipe_scope_search_path(monkeypatch):
    """A 12-digit scope adds --search-path public,aws_<id>; 'all' keeps the aggregator default;
    a malformed scope raises before any subprocess call (defense vs forged payloads)."""
    import subprocess as sp
    import compliance
    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd

        class P:
            returncode = 0
            stdout = "{}"
            stderr = ""
        return P()

    monkeypatch.setattr(sp, "run", fake_run)
    compliance.run_powerpipe("cis_v400", "postgres://x", "123456789012")
    assert "--search-path" in seen["cmd"]
    assert "public,aws_123456789012" in seen["cmd"]

    compliance.run_powerpipe("cis_v400", "postgres://x", "all")
    assert "--search-path" not in seen["cmd"]

    import pytest
    with pytest.raises(ValueError):
        compliance.run_powerpipe("cis_v400", "postgres://x", "123; DROP TABLE x")


class _FakeConn:
    """conn.run stub for the notify pause-flag read (gap L192)."""

    def __init__(self, paused=None, raise_on_read=False):
        self._paused = paused
        self._raise = raise_on_read

    def run(self, *_a, **_k):
        if self._raise:
            raise RuntimeError("db down")
        return [] if self._paused is None else [[str(self._paused).lower()]]


class _FakeSns:
    def __init__(self, captured):
        self._c = captured

    def publish(self, **kw):
        self._c.update(kw)
        return {"MessageId": "m-1"}


TOTALS = {"pass_rate": 75.0, "total_controls": 4, "ok": 3, "alarm": 1, "info": 0, "skip": 0, "error": 0}


def _patch_sns(monkeypatch, captured):
    import boto3

    monkeypatch.setattr(boto3, "client", lambda *_a, **_k: _FakeSns(captured))


def test_notify_completed_noop_without_topic(monkeypatch):
    monkeypatch.delenv("DIAGNOSIS_SNS_TOPIC_ARN", raising=False)
    assert compliance.notify_completed(_FakeConn(), "cis_v300", TOTALS) is None


def test_notify_completed_publishes_benchmark_and_counts(monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    monkeypatch.setenv("APP_DOMAIN", "awsops.example.com")
    captured = {}
    _patch_sns(monkeypatch, captured)
    assert compliance.notify_completed(_FakeConn(paused=False), "cis_v300", TOTALS, scope="all") == "m-1"
    assert captured["TopicArn"] == "arn:aws:sns:x:1:t"
    assert "cis_v300" in captured["Message"]
    assert "통과: 3" in captured["Message"] and "실패(Alarm): 1" in captured["Message"]
    assert "https://awsops.example.com/compliance" in captured["Message"]


def test_notify_completed_respects_admin_pause(monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    captured = {}
    _patch_sns(monkeypatch, captured)
    assert compliance.notify_completed(_FakeConn(paused=True), "cis_v300", TOTALS) is None
    assert captured == {}  # paused → no publish


def test_notify_completed_pause_read_failure_fails_open(monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    captured = {}
    _patch_sns(monkeypatch, captured)
    assert compliance.notify_completed(_FakeConn(raise_on_read=True), "cis_v300", TOTALS) == "m-1"


def test_notify_completed_never_raises_on_publish_failure(monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    import boto3

    def boom(*_a, **_k):
        raise RuntimeError("sns down")

    monkeypatch.setattr(boto3, "client", boom)
    assert compliance.notify_completed(_FakeConn(paused=False), "cis_v300", TOTALS) is None
