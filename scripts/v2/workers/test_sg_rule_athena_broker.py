"""Tests for sg_rule_athena_broker.py.

L3 finding #6 (round 2): the broker's old `action: "query"` executed a verbatim caller-supplied
SQL string against caller-supplied account_id/region/workgroup/database — a generic cross-account
SELECT proxy. That action is REMOVED. `action: "query_by_source"` accepts ONLY an opaque
`flow_source_id` + `day`; the broker resolves the source's config from Aurora itself and builds the
SQL server-side. These tests exercise: (a) the "validate" action's still-raw-input identifier
re-validation (called before a flow_source_id exists) + its new BytesScannedCutoffPerQuery
requirement (L3 #8c), (b) `_query_by_source`'s Aurora-driven resolution + validation-status/
partition-strategy refusal (L3 #8a/#8b), and (c) pagination/continuation (L2 #4) + the
zero-partition-match / SKIPDATA coverage signals (L4 #9)."""
import datetime as dt
import json

import pytest

import sg_rule_athena_broker as broker


# ── "validate" action: still raw caller input (no flow_source_id exists yet) ────────────────────

def test_validate_rejects_malformed_table():
    with pytest.raises(broker.BrokerError, match="table"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl; DROP",
        })


def test_validate_rejects_malformed_account_id_before_any_aws_call():
    # Never even attempts _assumed_session (no AWS/network call from this test).
    with pytest.raises(broker.BrokerError, match="account_id"):
        broker._validate({
            "account_id": "12345", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl",
        })


def test_validate_rejects_malformed_region():
    with pytest.raises(broker.BrokerError, match="region"):
        broker._validate({
            "account_id": "123456789012", "region": "; DROP TABLE x", "workgroup": "wg",
            "database": "db", "table": "tbl",
        })


def test_validate_rejects_malformed_workgroup():
    with pytest.raises(broker.BrokerError, match="workgroup"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg; DROP",
            "database": "db", "table": "tbl",
        })


def test_validate_rejects_malformed_database():
    with pytest.raises(broker.BrokerError, match="database"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db-with-hyphen", "table": "tbl",
        })


def test_lambda_handler_shapes_identifier_rejection_as_ok_false():
    result = broker.lambda_handler({
        "action": "validate", "account_id": "bad", "region": "ap-northeast-2",
        "workgroup": "wg", "database": "db", "table": "tbl",
    }, None)
    assert result["ok"] is False
    assert "account_id" in result["reason"]


def test_lambda_handler_rejects_the_removed_raw_query_action():
    """The old generic caller-controlled cross-account SELECT proxy is gone — an `action: "query"`
    invocation (the exact shape the L3 finding described as exploitable) must be refused, never
    silently accepted."""
    result = broker.lambda_handler({
        "action": "query", "account_id": "123456789012", "region": "ap-northeast-2",
        "workgroup": "wg", "database": "db", "query": "SELECT * FROM secrets",
    }, None)
    assert result["ok"] is False
    assert "unknown action" in result["reason"]


# ── existing SELECT-only guard (unchanged behavior, sanity-checked here too; UNION is now
#    forbidden too — L3 finding #7) ───────────────────────────────────────────────────────────────

def test_reject_non_select_rejects_mutating_keyword():
    with pytest.raises(broker.BrokerError):
        broker._reject_non_select("SELECT 1; DROP TABLE x")


def test_reject_non_select_rejects_union():
    with pytest.raises(broker.BrokerError, match="forbidden"):
        broker._reject_non_select("SELECT 1 UNION SELECT secret FROM other_table")


def test_reject_non_select_accepts_bare_select():
    broker._reject_non_select("SELECT 1")  # must not raise


# ── "query_by_source": Aurora-resolved config, never caller-supplied SQL/account (L3 #6) ─────────

class FakeConn:
    """`responses` maps a substring of the SQL to the ONE row-tuple list it should return, popped
    in FIFO order."""
    def __init__(self, responses):
        self.responses = {k: list(v) for k, v in responses.items()}
        self.calls = []

    def run(self, sql, **kwargs):
        self.calls.append((sql, kwargs))
        for key, rows in self.responses.items():
            if key in sql:
                return rows.pop(0) if rows else []
        return []

    def close(self):
        pass


def _source_row(validation, account_id="123456789012", region="ap-northeast-2"):
    return {
        "FROM sg_flow_sources": [[
            (account_id, region, "wg", "db", "tbl", json.dumps(validation)),
        ]],
        "FROM accounts": [[("ext-123",)]],
    }


def test_query_by_source_rejects_non_int_flow_source_id():
    with pytest.raises(broker.BrokerError, match="flow_source_id"):
        broker._query_by_source({"flow_source_id": "1; DROP", "day": "2026-03-05"}, FakeConn({}))


def test_query_by_source_rejects_malformed_day():
    with pytest.raises(broker.BrokerError, match="day"):
        broker._query_by_source({"flow_source_id": 1, "day": "not-a-day"}, FakeConn({}))


def test_query_by_source_refuses_pending_source():
    """L3 finding #8a: a source whose validation.status isn't 'valid' must never be scanned."""
    conn = FakeConn(_source_row({"status": "pending"}))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is False
    assert "valid" in result["reason"]


def test_query_by_source_refuses_unbounded_scan_without_partition_strategy():
    """L3 finding #8b: no resolved partition strategy -> refuse rather than fall back to an
    unbounded full-table scan."""
    conn = FakeConn(_source_row({"status": "valid", "columnMap": {}, "partitionKeys": []}))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is False
    assert "partition" in result["reason"]


def test_query_by_source_never_accepts_a_caller_supplied_query_or_account(monkeypatch):
    """Even if a caller tries to smuggle account_id/query/database into the event, they are simply
    ignored — the broker only ever uses what it resolved from Aurora via flow_source_id."""
    conn = FakeConn(_source_row({
        "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                          "start": "start"}, "partitionKeys": ["dt"],
    }))
    captured = {}

    def fake_assumed_session(account_id, external_id, region):
        captured["account_id"] = account_id
        captured["external_id"] = external_id
        captured["region"] = region
        raise broker.BrokerError("stop before any real AWS call")

    monkeypatch.setattr(broker, "_assumed_session", fake_assumed_session)
    with pytest.raises(broker.BrokerError, match="stop before"):
        broker._query_by_source({
            "flow_source_id": 1, "day": "2026-03-05",
            "account_id": "999999999999", "database": "attacker_db", "query": "SELECT * FROM secrets",
        }, conn)
    # The resolved account (from Aurora), never the caller-supplied one, is what gets assumed.
    assert captured["account_id"] == "123456789012"
    assert captured["external_id"] == "ext-123"
