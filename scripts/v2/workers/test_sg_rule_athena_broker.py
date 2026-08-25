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


# ── MAJOR fix: `_validate` must ALSO resolve the optional `account_id`/`region` columns into
#    `columnMap`. They are not Flow Log fields, so the required-field loop can never put them there
#    — and without them `sg_rule_matching._build_scope_predicate` is unreachable dead code, leaving
#    a centralized/org-wide flow-log table scanned unscoped. ───────────────────────────────────────

_CANONICAL_FLOW_COLUMNS = ["interface-id", "srcaddr", "dstaddr", "srcport", "dstport", "protocol",
                            "action", "log-status", "start", "end"]


def _validate_with_columns(monkeypatch, conn, columns):
    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c} for c in columns]},
                "PartitionKeys": [{"Name": "dt", "Type": "date"}],
                "Parameters": {},
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    return broker._validate({
        "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
        "database": "db", "table": "tbl",
    }, conn)


def test_validate_resolves_optional_account_id_and_region_into_column_map(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_with_columns(
        monkeypatch, conn, _CANONICAL_FLOW_COLUMNS + ["account_id", "region"])
    assert result["columnMap"]["account_id"] == "account_id"
    assert result["columnMap"]["region"] == "region"


def test_validate_omits_account_id_and_region_when_the_table_has_no_such_columns(monkeypatch):
    """Absence is not an error — a single-account table (the common case) simply gets no scope
    predicate, exactly as before."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_with_columns(monkeypatch, conn, _CANONICAL_FLOW_COLUMNS)
    assert "account_id" not in result["columnMap"]
    assert "region" not in result["columnMap"]
    assert result["scopeResolution"] == {"account_id": None, "region": None}
    assert result["scannedUnscoped"] is True


# ── MAJOR fix (item 1, round 2): the scope predicate is unreachable for the very table layout it
#    targets — centralized/org-wide flow-log tables canonically carry account_id/region as Glue
#    PARTITION KEYS, never plain table columns. The round-1 fix only ever searched
#    StorageDescriptor.Columns, so this table layout still resolved nothing. Also verifies the
#    hyphen-alias mechanism (already used for the required Flow Log fields) now applies here too. ──

def _validate_with_partition_keys(monkeypatch, conn, extra_partition_keys):
    """Like `_validate_with_columns`, but lets a test add extra Glue PartitionKeys (beyond the
    baseline `dt`/date key every fixture needs to satisfy the "table has a bound-able partition
    scheme" check) instead of only StorageDescriptor columns."""
    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c} for c in _CANONICAL_FLOW_COLUMNS]},
                "PartitionKeys": [{"Name": "dt", "Type": "date"}] + list(extra_partition_keys),
                "Parameters": {},
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    return broker._validate({
        "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
        "database": "db", "table": "tbl",
    }, conn)


def test_validate_resolves_scope_from_partition_keys_not_only_columns(monkeypatch):
    """Both scope fields are Glue PARTITION KEYS (not table columns, per the CI review's exact
    ask) — the resolved columnMap must still carry them, and the predicate built from that
    resolved config must still scope the query, using the hyphen alias `account-id` (the SAME
    alias mechanism the required-field loop already uses for `interface-id`/`log-status`)."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_with_partition_keys(monkeypatch, conn, [
        {"Name": "account-id", "Type": "string"}, {"Name": "region", "Type": "string"},
    ])
    assert result["columnMap"]["account_id"] == "account-id"
    assert result["columnMap"]["region"] == "region"
    assert result["scopeResolution"] == {"account_id": "partition", "region": "partition"}
    assert result["scannedUnscoped"] is False

    import sg_rule_matching as sm
    source = {"account_id": "123456789012", "region": "ap-northeast-2", "database_name": "db",
              "table_name": "tbl", "validation": result}
    sql = sm.build_day_select(source, dt.date(2026, 3, 5))
    assert '"account-id" = \'123456789012\'' in sql
    assert '"region" = \'ap-northeast-2\'' in sql


def test_validate_prefers_partition_key_form_over_column_when_both_present(monkeypatch):
    """When the SAME canonical field resolves via both a partition key and a plain column, the
    partition-key form must win — only it actually prunes scanned partition files."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})

    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c} for c in _CANONICAL_FLOW_COLUMNS]
                                       + [{"Name": "account_id"}]},
                "PartitionKeys": [{"Name": "dt", "Type": "date"}, {"Name": "account_id", "Type": "string"}],
                "Parameters": {},
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    result = broker._validate({
        "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
        "database": "db", "table": "tbl",
    }, conn)
    assert result["scopeResolution"]["account_id"] == "partition"


# ── MAJOR fix (item 4, round 2): a single-key partition scheme whose Glue type isn't date-shaped
#    must be REJECTED at validation time — round 1 only enforced this at runtime scan time
#    (`has_resolved_partition_strategy`'s hard-refuse), so a brand-new such source validated
#    `status: "valid"` yet every real scan permanently refused it. ──────────────────────────────────

def test_validate_rejects_a_non_date_typed_single_partition_key(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})

    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c} for c in _CANONICAL_FLOW_COLUMNS]},
                "PartitionKeys": [{"Name": "dt", "Type": "bigint"}],
                "Parameters": {},
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    with pytest.raises(broker.BrokerError, match="not date-shaped"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl",
        }, conn)


def test_validate_still_accepts_a_date_typed_single_partition_key(monkeypatch):
    """The pre-existing, common-case single date-typed key must keep validating successfully —
    this MAJOR fix only rejects non-date-shaped types."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_with_columns(monkeypatch, conn, _CANONICAL_FLOW_COLUMNS)
    assert result["ok"] is True
    assert result["partitionKeyTypes"] == ["date"]


def test_query_by_source_never_accepts_a_caller_supplied_query_or_account(monkeypatch):
    """Even if a caller tries to smuggle account_id/query/database into the event, they are simply
    ignored — the broker only ever uses what it resolved from Aurora via flow_source_id."""
    conn = FakeConn(_source_row({
        "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                          "start": "start"}, "partitionKeys": ["dt"],
        "partitionKeyTypes": ["date"],
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
        "partitionKeyTypes": ["date"], "partitionStrategy": "partition_keys",
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
        "partitionKeys": ["dt"], "partitionKeyTypes": ["date"], "optionalFields": [],
        "partitionStrategy": "projection",
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
        "partitionKeys": ["dt"], "partitionKeyTypes": ["date"], "optionalFields": [],
        "partitionStrategy": "partition_keys",
    })
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert called["n"] == 1
    assert result["ok"] is False
    assert result.get("zero_partition_match") is True


# ── item 8 follow-up fix: an unverifiable Glue partition check must refuse the day, never ────────
#    silently collapse into "confirmed present" (which the old boolean-returning version did). ───

class FakeGlueRaises:
    def get_partitions(self, **kwargs):
        raise RuntimeError("Glue API hiccup")


def test_partition_exists_returns_none_on_glue_error():
    result = broker._partition_exists(
        FakeGlueRaises(), "db", "tbl", dt.date(2026, 3, 5),
        {"partitionKeys": ["dt"], "partitionKeyTypes": ["date"]})
    assert result is None


def test_partition_exists_returns_none_on_an_unsafe_single_partition_key():
    """A stored single partition key that fails `_safe_ident` is genuinely unverifiable — it must
    return `None` (so the caller refuses the day and retries), never `True` ("partition confirmed
    present"), which would let a corrupted stored identifier manufacture a confident zero-traffic
    day. Glue must never be called at all for it."""
    class FakeGlueNeverCalled:
        def get_partitions(self, **kwargs):
            raise AssertionError("Glue must never be called for an unsafe identifier")

    result = broker._partition_exists(
        FakeGlueNeverCalled(), "db", "tbl", dt.date(2026, 3, 5),
        {"partitionKeys": ["dt; DROP"], "partitionKeyTypes": ["date"]})
    assert result is None


# ── MAJOR fix: the existence-check window must match the QUERY window. ───────────────────────────
#    `sg_rule_matching._build_partition_predicate` widens the query to partitions {D, D+1} (Hive
#    partitions are keyed by delivery time, so day-D flows can land in D+1's partition file), so a
#    check that only looked at day D would report `zero_partition_match` forever for a legitimately
#    zero-traffic day D whose D+1 partition exists — permanently stalling the watermark.

class FakeGluePartitions:
    """Answers `get_partitions` from a set of ISO day strings that actually have a partition: it
    simply reports a hit when the Expression mentions one of them, and records every Expression it
    was handed so the built predicate itself can be asserted on."""
    def __init__(self, existing_days):
        self.existing_days = list(existing_days)
        self.expressions = []

    def get_partitions(self, DatabaseName, TableName, Expression, MaxResults):
        self.expressions.append(Expression)
        if any(d in Expression for d in self.existing_days):
            return {"Partitions": [{"Values": ["x"]}]}
        return {"Partitions": []}


def test_partition_exists_true_when_only_the_next_day_partition_exists():
    """Day D has no partition (zero traffic) but D+1's does — the widened check must find it and
    return True, matching the query's own {D, D+1} predicate."""
    glue = FakeGluePartitions(["2026-03-06"])
    result = broker._partition_exists(
        glue, "db", "tbl", dt.date(2026, 3, 5),
        {"partitionKeys": ["dt"], "partitionKeyTypes": ["date"]})
    assert result is True
    # Item 3 follow-up fix (round 2): a genuinely `date`-typed key gets a typed `DATE '...'`
    # literal, not a bare string — Athena/Trino rejects comparing a `date` column to a string.
    assert glue.expressions == ["dt IN (DATE '2026-03-05', DATE '2026-03-06')"]


def test_partition_exists_keeps_string_literal_for_a_string_typed_key():
    """A string/varchar/char-typed single key (the common manually-partitioned-as-text pattern)
    must keep the plain quoted-string literal — only genuinely date/timestamp-typed keys switch to
    a typed literal."""
    glue = FakeGluePartitions(["2026-03-06"])
    broker._partition_exists(
        glue, "db", "tbl", dt.date(2026, 3, 5),
        {"partitionKeys": ["dt"], "partitionKeyTypes": ["string"]})
    assert glue.expressions == ["dt IN ('2026-03-05', '2026-03-06')"]


def test_partition_exists_false_when_neither_day_has_a_partition():
    """Neither D nor D+1 has a partition — still the genuine "wrong partition-key mapping" signal
    the caller wants (False), not None/True."""
    glue = FakeGluePartitions([])
    result = broker._partition_exists(
        glue, "db", "tbl", dt.date(2026, 3, 5),
        {"partitionKeys": ["dt"], "partitionKeyTypes": ["date"]})
    assert result is False


def test_partition_exists_hive_expression_covers_both_days_across_a_month_boundary():
    """The Hive year/month/day branch must OR together D's and D+1's OWN year/month/day values —
    each half carries its own values, so a month/year rollover is handled correctly."""
    glue = FakeGluePartitions([])
    broker._partition_exists(
        glue, "db", "tbl", dt.date(2026, 3, 31),
        {"partitionKeys": ["year", "month", "day"], "partitionKeyTypes": ["string"] * 3})
    expr = glue.expressions[0]
    assert "(year = '2026' AND month = '03' AND day = '31')" in expr
    assert "(year = '2026' AND month = '04' AND day = '01')" in expr
    assert " OR " in expr


def test_query_by_source_commits_a_zero_traffic_day_when_only_the_next_day_partition_exists(monkeypatch):
    """End-to-end of the same fix through `_query_by_source` (pattern of
    `test_partition_keys_strategy_still_runs_glue_partition_check`, but with the REAL
    `_partition_exists`): an empty Athena result for a day D with no partition of its own, whose
    D+1 partition does exist, must commit as a genuine zero-traffic day — not
    `zero_partition_match`."""
    conn = FakeConn(_source_row({
        "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                          "start": "start"},
        "partitionKeys": ["dt"], "partitionKeyTypes": ["date"], "optionalFields": [],
        "partitionStrategy": "partition_keys",
    }))
    glue = FakeGluePartitions(["2026-03-06"])

    class SessionWithGlue:
        def client(self, name):
            return glue if name == "glue" else object()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: SessionWithGlue())
    monkeypatch.setattr(broker, "_run_athena_query",
                         lambda *a, **k: {"ok": True, "athena": object(), "query_execution_id": "q1"})
    monkeypatch.setattr(broker, "_fetch_page", lambda *a, **k: (["c1"], [], None))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is True
    assert "zero_partition_match" not in result
    assert "partition_check_unverified" not in result


def test_query_by_source_refuses_day_when_partition_check_is_unverifiable(monkeypatch):
    """A Glue API error while checking for a matching partition must NOT be trusted as "partition
    confirmed present, so the empty Athena result is genuine zero-traffic" — the old
    boolean-returning `_partition_exists` collapsed "unverifiable" into the same truthy value as
    "confirmed present". The day must be refused (watermark not advanced), not silently committed."""
    conn, called = _empty_query_by_source_setup(monkeypatch, {
        "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                          "start": "start"},
        "partitionKeys": ["dt"], "partitionKeyTypes": ["date"], "optionalFields": [],
        "partitionStrategy": "partition_keys",
    })
    monkeypatch.setattr(broker, "_partition_exists", lambda *a, **k: None)
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is False
    assert result.get("partition_check_unverified") is True
    assert "zero_partition_match" not in result
