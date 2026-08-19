"""Pipeline-level tests for sg_rule_scan.py — the design spec's "Pipeline" test list.
Uses a lightweight FakeConn (pg8000.native.Connection-shaped `.run(sql, **kwargs)`) instead of a
real Postgres — these test the ORCHESTRATION logic (idempotent delete-then-insert, watermark
advance, one-query-per-day, rescan window, transaction rollback), not SQL correctness itself."""
import datetime as dt
import json

import pytest

import sg_rule_scan as scan
import sg_rule_matching as sm


class FakeConn:
    """Records every `.run()` call; BEGIN/COMMIT/ROLLBACK are tracked, not executed against a real
    DB. `responses` is a dict of substring -> list of rows (popped in FIFO order per substring) for
    SELECT-shaped calls; INSERT/UPDATE/DELETE calls just get recorded and return []."""

    def __init__(self, responses=None):
        self.calls = []
        self.responses = {k: list(v) for k, v in (responses or {}).items()}
        self.in_txn = False
        self.committed = 0
        self.rolled_back = 0

    def run(self, sql, **kwargs):
        self.calls.append((sql, kwargs))
        if sql.strip() == "BEGIN":
            self.in_txn = True
            return []
        if sql.strip() == "COMMIT":
            self.in_txn = False
            self.committed += 1
            return []
        if sql.strip() == "ROLLBACK":
            self.in_txn = False
            self.rolled_back += 1
            return []
        for key, rows in self.responses.items():
            if key in sql:
                return rows.pop(0) if rows else []
        return []

    def sql_calls(self, substring):
        return [c for c in self.calls if substring in c[0]]


def utc(y, mo, d, h=0):
    return dt.datetime(y, mo, d, h, tzinfo=dt.timezone.utc)


# ── source validation ────────────────────────────────────────────────────────────────────────────

def test_load_source_raises_when_not_configured():
    conn = FakeConn({"FROM sg_flow_sources": [[]]})
    with pytest.raises(scan.SourceNotConfigured):
        scan.load_source(conn, "123456789012", "ap-northeast-2")


def test_load_source_raises_when_disabled():
    conn = FakeConn({"FROM sg_flow_sources": [[
        (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", False, "{}", utc(2026, 1, 1)),
    ]]})
    with pytest.raises(scan.SourceNotConfigured):
        scan.load_source(conn, "123456789012", "ap-northeast-2")


def test_load_source_raises_when_validation_invalid():
    conn = FakeConn({"FROM sg_flow_sources": [[
        (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True, json.dumps({"status": "invalid"}), utc(2026, 1, 1)),
    ]]})
    with pytest.raises(scan.SourceInvalid):
        scan.load_source(conn, "123456789012", "ap-northeast-2")


def test_load_source_ok_when_pending_or_valid():
    conn = FakeConn({"FROM sg_flow_sources": [[
        (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True, json.dumps({"status": "valid"}), utc(2026, 1, 1)),
    ]]})
    row = scan.load_source(conn, "123456789012", "ap-northeast-2")
    assert row["id"] == 1
    assert row["workgroup"] == "wg"


# ── watermark ─────────────────────────────────────────────────────────────────────────────────────

def test_last_committed_day_none_when_no_succeeded_runs():
    conn = FakeConn({"FROM sg_rule_scan_runs": [[(None,)]]})
    assert scan.last_committed_day(conn, 1) is None


def test_last_committed_day_returns_max_succeeded_partition():
    import datetime
    conn = FakeConn({"FROM sg_rule_scan_runs": [[(datetime.date(2026, 3, 5),)]]})
    assert scan.last_committed_day(conn, 1) == datetime.date(2026, 3, 5)


# ── inventory versioning (upsert_inventory_and_versions) ────────────────────────────────────────

def test_upsert_inventory_opens_first_version_when_none_open():
    conn = FakeConn({"sg_rule_inventory_versions": [[]]})  # no open version
    rules = [{"rule_id": "sgr-1", "group_id": "sg-1", "is_egress": False, "protocol": "tcp",
              "from_port": 443, "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8",
              "description": None}]
    scan.upsert_inventory_and_versions(conn, "123456789012", "ap-northeast-2", rules, utc(2026, 3, 5))
    inserts = [c for c in conn.calls if "INSERT INTO sg_rule_inventory_versions" in c[0]]
    assert len(inserts) == 1
    updates = [c for c in conn.calls if "UPDATE sg_rule_inventory_versions" in c[0]]
    assert len(updates) == 0


def test_upsert_inventory_closes_and_opens_new_version_on_fingerprint_change():
    old_fp = sm.rule_fingerprint({"group_id": "sg-1", "is_egress": False, "protocol": "tcp",
                                   "from_port": 80, "to_port": 80, "peer_kind": "cidr", "peer_value": "10.0.0.0/8"})
    conn = FakeConn({"sg_rule_inventory_versions": [[(old_fp,)]]})  # currently-open version has the OLD fingerprint
    rules = [{"rule_id": "sgr-1", "group_id": "sg-1", "is_egress": False, "protocol": "tcp",
              "from_port": 443, "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8",
              "description": None}]  # NEW shape (443, not 80)
    scan.upsert_inventory_and_versions(conn, "123456789012", "ap-northeast-2", rules, utc(2026, 3, 5))
    closes = [c for c in conn.calls if "UPDATE sg_rule_inventory_versions" in c[0]]
    opens = [c for c in conn.calls if "INSERT INTO sg_rule_inventory_versions" in c[0]]
    assert len(closes) == 1
    assert len(opens) == 1


def test_upsert_inventory_no_new_version_when_fingerprint_unchanged():
    fp = sm.rule_fingerprint({"group_id": "sg-1", "is_egress": False, "protocol": "tcp",
                               "from_port": 443, "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8"})
    conn = FakeConn({"sg_rule_inventory_versions": [[(fp,)]]})
    rules = [{"rule_id": "sgr-1", "group_id": "sg-1", "is_egress": False, "protocol": "tcp",
              "from_port": 443, "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8",
              "description": None}]  # SAME shape
    scan.upsert_inventory_and_versions(conn, "123456789012", "ap-northeast-2", rules, utc(2026, 3, 5))
    closes = [c for c in conn.calls if "UPDATE sg_rule_inventory_versions" in c[0]]
    opens = [c for c in conn.calls if "INSERT INTO sg_rule_inventory_versions" in c[0]]
    assert len(closes) == 0
    assert len(opens) == 0


# ── process_day: idempotent delete-then-insert, transaction, one row per rule/day ────────────────

def _versions(rule_id="sgr-1", **overrides):
    base = {"rule_id": rule_id, "fingerprint": "fp1", "group_id": "sg-1", "is_egress": False,
            "protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
            "peer_value": "10.0.0.0/8", "valid_from": utc(2026, 1, 1), "valid_to": None}
    base.update(overrides)
    return {rule_id: [base]}


def test_process_day_deletes_before_inserting_that_day_rows():
    conn = FakeConn()
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [], _versions(), {}, None)
    deletes = [c for c in conn.calls if c[0].startswith("DELETE FROM sg_rule_activity_daily")]
    inserts = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")]
    assert len(deletes) == 1
    assert len(inserts) == 1  # one row for the one rule
    assert conn.committed == 1
    assert conn.rolled_back == 0


def test_process_day_is_idempotent_on_reprocessing_the_same_day():
    """Calling process_day twice for the same day must not accumulate counts — each call
    delete-then-inserts, so the second call's row replaces (not adds to) the first's."""
    conn = FakeConn()
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [
                          {"srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2", "dstport": "443",
                           "protocol": "6", "bytes": "100", "cnt": "1"},
                      ], _versions(), {}, None)
    conn2_calls_first = len(conn.calls)
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [
                          {"srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2", "dstport": "443",
                           "protocol": "6", "bytes": "100", "cnt": "1"},
                      ], _versions(), {}, None)
    deletes = [c for c in conn.calls if c[0].startswith("DELETE FROM sg_rule_activity_daily")]
    assert len(deletes) == 2  # one delete per call — never skipped on a re-run
    assert conn.committed == 2


def test_process_day_rolls_back_on_failure():
    class ExplodingConn(FakeConn):
        def run(self, sql, **kwargs):
            if sql.startswith("INSERT INTO sg_rule_activity_daily"):
                raise RuntimeError("boom")
            return super().run(sql, **kwargs)
    conn = ExplodingConn()
    with pytest.raises(RuntimeError):
        scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                          dt.date(2026, 3, 5), [], _versions(), {}, None)
    assert conn.rolled_back == 1
    assert conn.committed == 0


def test_process_day_crossing_day_downgrades_to_unassessable_and_no_lower_bound():
    versions = {
        "sgr-1": [
            {"rule_id": "sgr-1", "fingerprint": "fp1", "group_id": "sg-1", "is_egress": False,
             "protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
             "peer_value": "10.0.0.0/8", "valid_from": utc(2026, 3, 5, 14), "valid_to": None},
        ],
    }
    conn = FakeConn()
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [
                                {"srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2", "dstport": "443",
                                 "protocol": "6", "bytes": "999", "cnt": "5"},
                            ], versions, {}, None)
    assert res["any_crossing"] is True
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    assert insert_call[1]["cm"] == 0  # no flows counted against an unassessable rule/day


def test_process_day_matches_compatible_flow():
    conn = FakeConn()
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [
                                {"srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2", "dstport": "443",
                                 "protocol": "6", "bytes": "500", "cnt": "3"},
                            ], _versions(), {}, None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    assert insert_call[1]["cm"] == 3
    assert insert_call[1]["cb"] == 500


def test_process_day_no_uniqueness_conflict_on_concurrent_retry():
    """Two process_day calls for the SAME partition must both succeed (no unique index on
    sg_rule_scan_runs beyond the primary key `id`, which is a fresh uuid every call)."""
    conn = FakeConn()
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [], _versions(), {}, None)
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [], _versions(), {}, None)
    runs = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_scan_runs")]
    assert len(runs) == 2
    assert runs[0][1]["id"] != runs[1][1]["id"]  # distinct run ids, no conflict


# ── run() orchestration: one query per account/region/day, rescan window wiring ─────────────────

class FakeLambda:
    def __init__(self, response):
        self.response = response
        self.invocations = []

    def invoke(self, FunctionName, Payload):
        self.invocations.append(json.loads(Payload))
        class R:
            def __init__(self, body):
                self._body = body
            def get(self, k, default=None):
                return self if k == "Payload" else default
            def read(self):
                return json.dumps(self.response_body).encode("utf-8")
        r = R(None)
        r.response_body = self.response
        return {"Payload": r}


class FakeEc2:
    def describe_security_group_rules(self, **kwargs):
        return {"SecurityGroupRules": []}

    def describe_network_interfaces(self, **kwargs):
        return {"NetworkInterfaces": []}


def test_run_one_broker_invoke_for_the_eligible_day(monkeypatch):
    monkeypatch.setenv("SG_RULE_ATHENA_BROKER_ARN", "arn:aws:lambda:ap-northeast-2:123456789012:function:broker")
    conn = FakeConn({
        "FROM sg_flow_sources": [[
            (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True, json.dumps({"status": "valid"}), utc(2020, 1, 1)),
        ]],
        "FROM accounts": [[]],
        "FROM sg_rule_scan_runs": [[(None,)]],  # no watermark yet -> first run starts at source created day
        "sg_rule_inventory_versions": [[]],
        "FROM sg_eni_membership_snapshots": [[]],
    })
    fake_lambda = FakeLambda({"ok": True, "rows": []})
    monkeypatch.setattr(scan.dt, "datetime", scan.dt.datetime)  # no-op, keeps real clock behavior visible
    # Force "now" far enough past the source's created day that the delivery-lag grace period has cleared.
    result = scan.run(
        {"account_id": "123456789012", "region": "ap-northeast-2"}, conn,
        ec2_client_factory=lambda *a, **k: FakeEc2(),
        lambda_client_factory=lambda: fake_lambda,
    )
    assert result["status"] == "ok"
    assert len(fake_lambda.invocations) >= 1
    assert fake_lambda.invocations[0]["action"] == "query"
    # one query per account/region/day — never per-rule.
    assert fake_lambda.invocations[0]["query"].count("SELECT") == 1


def test_run_returns_inventory_only_when_broker_not_configured(monkeypatch):
    monkeypatch.delenv("SG_RULE_ATHENA_BROKER_ARN", raising=False)
    conn = FakeConn({
        "FROM sg_flow_sources": [[
            (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True, json.dumps({"status": "valid"}), utc(2020, 1, 1)),
        ]],
        "FROM accounts": [[]],
        "sg_rule_inventory_versions": [[]],
    })
    result = scan.run(
        {"account_id": "123456789012", "region": "ap-northeast-2"}, conn,
        ec2_client_factory=lambda *a, **k: FakeEc2(),
    )
    assert result["status"] == "inventory_only"
