import json

from diagnosis import db


class FakeConn:
    def __init__(self):
        self.calls = []
        self.ret = []

    def run(self, sql, **kw):
        self.calls.append((sql, kw))
        return self.ret


# --- Task 2: db.py CRUD --------------------------------------------------

def test_create_report_inserts_running_row():
    c = FakeConn(); c.ret = [[123]]
    rid = db.create_report(c, worker_job_id="job-1", tier="mid", requested_by="u@x.io")
    assert rid == 123
    sql, kw = c.calls[0]
    assert "INSERT INTO diagnosis_reports" in sql
    assert kw["t"] == "mid" and kw["rb"] == "u@x.io" and kw["jid"] == "job-1"


def test_finish_report_sets_terminal_and_summary():
    c = FakeConn(); c.ret = [[123]]
    n = db.finish_report(c, 123, status="succeeded",
                         sources_used=["inventory", "cost"],
                         summary={"sections": 8}, artifact_uri="s3://b/k.md")
    assert n == 1
    sql, kw = c.calls[0]
    assert "UPDATE diagnosis_reports" in sql and "status=:s" in sql
    assert json.loads(kw["su"]) == ["inventory", "cost"]
    assert kw["s"] == "succeeded"


# --- Task 3: sources.py collectors --------------------------------------

from diagnosis import sources


def test_collector_degrades_on_exception(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("AccessDenied")
    # cost collector calls a boto3 client; force it to raise
    monkeypatch.setattr(sources, "_ce_client", boom)
    res = sources.collect_cost()
    assert res["key"] == "cost"
    assert res["ok"] is False and res["degraded"] is True
    assert "AccessDenied" in res["notes"]
    assert res["data"] == {"_failed": True}


def test_result_shape_keys():
    res = sources._result("inventory", ok=True, data={"x": 1})
    assert set(res) == {"key", "ok", "degraded", "notes", "data"}
    assert res["degraded"] is False


def test_what_changed_strips_pii(monkeypatch):
    import datetime as dt

    class _FakeCt:
        def lookup_events(self, **kw):
            return {"Events": [{
                "EventName": "RunInstances",
                "EventSource": "ec2.amazonaws.com",
                "EventTime": dt.datetime(2026, 6, 11, 0, 0, 0),
                "Username": "alice",                       # PII — must be dropped
                "Resources": [{"ResourceName": "i-abc"}],  # must be dropped
            }]}

    monkeypatch.setattr(sources, "_ct_client", lambda: _FakeCt())
    res = sources.collect_what_changed()
    assert res["ok"] is True
    ev = res["data"]["recent_changes"][0]
    assert set(ev) == {"name", "source", "time"}
    assert "username" not in {k.lower() for k in ev}
    assert "Resources" not in ev


def test_throttle_is_loud(monkeypatch):
    from botocore.exceptions import ClientError

    def throttled(*a, **k):
        raise ClientError({"Error": {"Code": "ThrottlingException"}}, "GetFindings")

    monkeypatch.setattr(sources, "_sh_client", throttled)
    res = sources.collect_posture()
    assert res["ok"] is False and res["degraded"] is True
    assert "THROTTLED" in res["notes"]
    assert res["data"] == {"_failed": True}


def test_cw_metrics_collector_present():
    assert hasattr(sources, "collect_cw_metrics")


# --- Task 4: sections.py -------------------------------------------------

from diagnosis import sections


def test_eight_sections_ordered_and_unique():
    s = sections.SECTIONS
    assert len(s) == 8
    keys = [x["key"] for x in s]
    assert keys[0] == "executive_summary"
    assert len(set(keys)) == 8
    for sec in s:
        assert sec["title"] and sec["prompt"] and isinstance(sec["sources"], list)


def test_cw_metrics_wired_into_compute_and_db_sections():
    by_key = {s["key"]: s for s in sections.SECTIONS}
    assert "cw_metrics" in by_key["compute_infrastructure"]["sources"]
    assert "cw_metrics" in by_key["database_storage"]["sources"]
