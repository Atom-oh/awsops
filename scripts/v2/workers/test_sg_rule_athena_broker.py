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
        }, None)


def test_validate_rejects_malformed_account_id_before_any_aws_call():
    # Never even attempts _assumed_session (no AWS/network call from this test).
    with pytest.raises(broker.BrokerError, match="account_id"):
        broker._validate({
            "account_id": "12345", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl",
        }, None)


def test_validate_rejects_malformed_region():
    with pytest.raises(broker.BrokerError, match="region"):
        broker._validate({
            "account_id": "123456789012", "region": "; DROP TABLE x", "workgroup": "wg",
            "database": "db", "table": "tbl",
        }, None)


def test_validate_rejects_malformed_workgroup():
    with pytest.raises(broker.BrokerError, match="workgroup"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg; DROP",
            "database": "db", "table": "tbl",
        }, None)


def test_validate_rejects_malformed_database():
    with pytest.raises(broker.BrokerError, match="database"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db-with-hyphen", "table": "tbl",
        }, None)


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


def _source_row(validation, account_id="123456789012", region="ap-northeast-2", enabled=True,
                 accounts_rows=(("ext-123",),)):
    return {
        "FROM sg_flow_sources": [[
            (account_id, region, "wg", "db", "tbl", json.dumps(validation), enabled),
        ]],
        "FROM accounts": [list(accounts_rows)],
    }


# ── round-4 CI-review finding (L3, items 1 + 3): `_load_source_row` must apply the SAME
#    enabled-required confused-deputy guard `validate`'s `_resolve_external_id` already enforces,
#    and must refuse a disabled `sg_flow_sources` row — even when `query_by_source` is invoked
#    directly, bypassing the dispatcher's own `WHERE enabled` filter. ─────────────────────────────

def test_query_by_source_refuses_a_disabled_account(monkeypatch):
    """item 1(a): an `accounts` row with `enabled=false` (modeled here as no matching row, since the
    real query carries `AND enabled`) must refuse the scan rather than assume with no ExternalId."""
    conn = FakeConn(_source_row({"status": "valid"}, accounts_rows=()))
    monkeypatch.setattr(broker, "_assumed_session",
                         lambda *a, **k: (_ for _ in ()).throw(AssertionError("must never be called")))
    with pytest.raises(broker.BrokerError, match="registered"):
        broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)


def test_query_by_source_refuses_an_unregistered_account(monkeypatch):
    """item 1(b): an account_id with no `accounts` row at all gets the same refusal."""
    conn = FakeConn(_source_row({"status": "valid"}, accounts_rows=()))
    monkeypatch.setattr(broker, "_assumed_session",
                         lambda *a, **k: (_ for _ in ()).throw(AssertionError("must never be called")))
    with pytest.raises(broker.BrokerError, match="registered"):
        broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)


def test_query_by_source_refuses_a_disabled_flow_source(monkeypatch):
    """item 3: a disabled `sg_flow_sources` row must be refused by `query_by_source` even when
    invoked directly (bypassing the dispatcher's own `WHERE enabled` filter) — any principal with
    `lambda:InvokeFunction` on this broker must not be able to drive a scan of a disabled source."""
    conn = FakeConn(_source_row({"status": "valid"}, enabled=False))
    monkeypatch.setattr(broker, "_assumed_session",
                         lambda *a, **k: (_ for _ in ()).throw(AssertionError("must never be called")))
    with pytest.raises(broker.BrokerError, match="disabled"):
        broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)


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


# ── round-3 finding #6: `validate` must resolve external_id from the `accounts` table server-side ─

def test_validate_resolves_external_id_from_accounts_table_ignoring_caller_supplied_value(monkeypatch):
    """A caller-supplied `external_id` in the event must be completely ignored — the value actually
    used to assume Role B must come from the `accounts` table, exactly like `_load_source_row`."""
    conn = FakeConn({"FROM accounts": [[("ext-real-from-table",)]]})
    captured = {}

    def fake_assumed_session(account_id, external_id, region):
        captured["account_id"] = account_id
        captured["external_id"] = external_id
        raise broker.BrokerError("stop before any real AWS call")

    monkeypatch.setattr(broker, "_assumed_session", fake_assumed_session)
    with pytest.raises(broker.BrokerError, match="stop before"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl",
            "external_id": "attacker-controlled-ext-id",  # must be ignored entirely
        }, conn)
    assert captured["external_id"] == "ext-real-from-table"
    assert captured["account_id"] == "123456789012"


def test_validate_rejects_an_unregistered_account_id(monkeypatch):
    """`validate` must not assume a role into an account_id with no enabled row in `accounts` —
    inverting the confused-deputy guard by trusting the caller entirely was the bug (bypassing the
    accounts table this same module resolves external_id from everywhere else)."""
    conn = FakeConn({"FROM accounts": [[]]})  # no matching enabled row
    monkeypatch.setattr(broker, "_assumed_session",
                         lambda *a, **k: (_ for _ in ()).throw(AssertionError("must never be called")))
    with pytest.raises(broker.BrokerError, match="registered"):
        broker._validate({
            "account_id": "999999999999", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl", "external_id": "attacker-ext",
        }, conn)


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


# ── round-3 finding #5: a continuation's query_execution_id must be bound back to the resolved ───
#    source/day — never trusted as a bare caller-supplied Athena identifier.

class FakeAthenaForContinuation:
    def __init__(self, exec_workgroup, exec_query, rows=None, data_scanned_bytes=0):
        self.exec_workgroup = exec_workgroup
        self.exec_query = exec_query
        self.rows = rows if rows is not None else []
        self.data_scanned_bytes = data_scanned_bytes
        self.get_query_execution_calls = []

    def get_query_execution(self, QueryExecutionId):
        self.get_query_execution_calls.append(QueryExecutionId)
        return {"QueryExecution": {
            "WorkGroup": self.exec_workgroup, "Query": self.exec_query,
            "Statistics": {"DataScannedInBytes": self.data_scanned_bytes},
        }}

    def get_query_results(self, **kwargs):
        return {"ResultSet": {"Rows": [{"Data": [{"VarCharValue": v} for v in row]} for row in self.rows]},
                "NextToken": None}


def _continuation_setup(monkeypatch, athena):
    conn = FakeConn(_source_row({
        "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                          "start": "start"}, "partitionKeys": ["dt"],
        "partitionStrategy": "partition_keys",
    }))
    monkeypatch.setattr(broker.sm, "build_day_select", lambda source, day: "SELECT 1 AS x")

    class FakeSessionContinuation:
        def client(self, name):
            return athena

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionContinuation())
    return conn


def test_continuation_rejects_a_query_execution_id_for_a_foreign_query(monkeypatch):
    """A query_execution_id whose real WorkGroup/QueryString does NOT match what this resolved
    flow_source_id+day would itself build server-side must be rejected — this is exactly the hole
    (paging through ANY Athena query reachable by the assumed role) round-3 finding #5 closes."""
    athena = FakeAthenaForContinuation(exec_workgroup="some-other-wg", exec_query="SELECT * FROM secrets")
    conn = _continuation_setup(monkeypatch, athena)
    with pytest.raises(broker.BrokerError, match="does not match"):
        broker._query_by_source({
            "flow_source_id": 1, "day": "2026-03-05",
            "continuation": {"query_execution_id": "q-foreign", "next_token": "tok", "columns": ["a"]},
        }, conn)
    assert athena.get_query_execution_calls == ["q-foreign"]


def test_continuation_accepts_a_query_execution_id_matching_the_resolved_source(monkeypatch):
    """The SAME resolved flow_source_id+day's own query_execution_id, whose real WorkGroup/Query
    match the server-rebuilt SQL exactly, is accepted and pages through normally."""
    athena = FakeAthenaForContinuation(exec_workgroup="wg", exec_query="SELECT 1 AS x",
                                        rows=[["v1"]])
    conn = _continuation_setup(monkeypatch, athena)
    result = broker._query_by_source({
        "flow_source_id": 1, "day": "2026-03-05",
        "continuation": {"query_execution_id": "q-real", "next_token": "tok", "columns": ["a"]},
    }, conn)
    assert result["ok"] is True
    assert result["done"] is True
    assert result["rows"] == [{"a": "v1"}]


# ── round-4 CI-review finding (L3, item 4): scan-bytes budget must be re-checked on the
#    continuation path too — a query that WAS over-budget must not have its results paged out
#    just because the workgroup/SQL-identity check alone passes. ───────────────────────────────────

def test_continuation_refuses_a_query_execution_over_the_bytes_budget(monkeypatch):
    """Even though the workgroup+SQL identity matches the resolved source's own query exactly, an
    execution whose `Statistics.DataScannedInBytes` exceeds the budget must be refused — proving the
    continuation path can no longer be used to page out results Athena flagged as over-budget."""
    over_budget = broker._DEFAULT_MAX_BYTES + 1
    athena = FakeAthenaForContinuation(exec_workgroup="wg", exec_query="SELECT 1 AS x",
                                        rows=[["v1"]], data_scanned_bytes=over_budget)
    conn = _continuation_setup(monkeypatch, athena)
    result = broker._query_by_source({
        "flow_source_id": 1, "day": "2026-03-05",
        "continuation": {"query_execution_id": "q-real", "next_token": "tok", "columns": ["a"]},
    }, conn)
    assert result["ok"] is False
    assert "budget" in result["reason"]
    assert result["data_scanned_bytes"] == over_budget


def test_continuation_still_refuses_a_pending_source():
    """The re-validation of validation.status must apply on the continuation path too (it used to
    be skipped entirely there)."""
    conn = FakeConn(_source_row({"status": "pending"}))
    result = broker._query_by_source({
        "flow_source_id": 1, "day": "2026-03-05",
        "continuation": {"query_execution_id": "q-1", "next_token": "tok", "columns": ["a"]},
    }, conn)
    assert result["ok"] is False
    assert "valid" in result["reason"]


# ── round-3 finding #3: the Glue-partition-existence check must be skipped entirely for a ────────
#    partition-projection source — it has no enumerable Glue partitions to check.

class FakeSession:
    def __init__(self):
        self.clients = {}

    def client(self, name):
        return self.clients.setdefault(name, object())


def _empty_query_by_source_setup(monkeypatch, validation):
    """Common wiring: an empty-result Athena query (no rows, no next_token) against a source whose
    `validation` is under test, with `_partition_exists` instrumented to record whether it was
    called at all."""
    conn = FakeConn(_source_row(validation))
    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSession())
    monkeypatch.setattr(broker, "_run_athena_query",
                         lambda *a, **k: {"ok": True, "athena": object(), "query_execution_id": "q1"})
    monkeypatch.setattr(broker, "_fetch_page", lambda *a, **k: (["c1"], [], None))
    called = {"n": 0}

    def fake_partition_exists(*a, **k):
        called["n"] += 1
        return False  # would trigger zero_partition_match if actually invoked

    monkeypatch.setattr(broker, "_partition_exists", fake_partition_exists)
    return conn, called


def test_projection_strategy_skips_glue_partition_check(monkeypatch):
    """A `projection`-strategy source (partitionKeys still non-empty — Glue keeps declaring the
    partition columns even with projection enabled — plus a non-None optionalFields list, exactly
    what `_validate` always emits) must NOT run the Glue GetPartitions check on an empty result: a
    projection table has no enumerable Glue partitions, so the check would always report
    `zero_partition_match` and permanently stall a legitimate zero-traffic day."""
    conn, called = _empty_query_by_source_setup(monkeypatch, {
        "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                          "start": "start"},
        "partitionKeys": ["dt"], "optionalFields": [], "partitionStrategy": "projection",
    })
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert called["n"] == 0
    assert result["ok"] is True
    assert "zero_partition_match" not in result


def test_partition_keys_strategy_still_runs_glue_partition_check(monkeypatch):
    """The real, enumerable `partition_keys` strategy must still run the check (regression guard —
    the restriction above must not accidentally disable the check for the case it exists for)."""
    conn, called = _empty_query_by_source_setup(monkeypatch, {
        "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                          "start": "start"},
        "partitionKeys": ["dt"], "optionalFields": [], "partitionStrategy": "partition_keys",
    })
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert called["n"] == 1
    assert result["ok"] is False
    assert result.get("zero_partition_match") is True
