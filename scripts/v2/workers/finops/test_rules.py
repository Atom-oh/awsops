from datetime import datetime, timedelta, timezone

from finops import rules


class FakeConn:
    """`rows` = the ebs_volume data rows to return for the main SELECT. `sync_run` controls the
    _require_fresh_inventory precheck (mirrors an inventory_sync_runs row): 'ok' (default) -> a
    succeeded run finished just now (even if `rows` is empty — a healthy sync that found nothing);
    'missing' -> no inventory_sync_runs row at all; 'failed' -> a row with status='failed'; a
    datetime -> a succeeded run that finished at that timestamp (used to simulate staleness)."""
    def __init__(self, rows, sync_run='ok'):
        self.rows = rows
        self.sync_run = sync_run

    def run(self, sql, **kw):
        if "FROM inventory_sync_runs" in sql:
            if self.sync_run == 'missing':
                return []
            if self.sync_run == 'failed':
                return [('failed', datetime.now(timezone.utc))]
            finished_at = self.sync_run if isinstance(self.sync_run, datetime) else datetime.now(timezone.utc)
            return [('succeeded', finished_at)]
        return self.rows


_NOW = datetime.now(timezone.utc)


def test_ebs_unattached_computes_savings_from_rate_card():
    conn = FakeConn([("vol-1", "ap-northeast-2", {"state": "available", "size": 100, "volume_type": "gp3",
                                                    "tags": {"Name": "old"}}, _NOW)])
    out = rules.ebs_unattached(conn, [0])
    assert len(out) == 1
    f = out[0]
    assert f["resource_id"] == "vol-1"
    assert f["category"] == "storage"
    assert f["monthly_savings_usd"] == round(100 * 0.0912, 2)
    assert f["tags"] == {"Name": "old"}
    assert f["finding_reason"] is None
    assert f["stale"] is False


def test_ebs_unattached_null_savings_when_size_missing():
    conn = FakeConn([("vol-2", "ap-northeast-2", {"state": "available", "size": None, "volume_type": "gp3"}, _NOW)])
    out = rules.ebs_unattached(conn, [0])
    assert out[0]["monthly_savings_usd"] is None


def test_ebs_unattached_unknown_volume_type_falls_back_to_default_rate():
    conn = FakeConn([("vol-3", "ap-northeast-2", {"state": "available", "size": 50, "volume_type": "weird"}, _NOW)])
    out = rules.ebs_unattached(conn, [0])
    assert out[0]["monthly_savings_usd"] == round(50 * 0.10, 2)


def test_ebs_unattached_flags_a_per_row_stale_captured_at_even_though_the_job_succeeded():
    # The job-level inventory_sync_runs row says 'succeeded' just now (sync_run='ok' default), but
    # THIS row's own captured_at is weeks old — exactly sync_lambda.py's M5 scenario: one account's
    # connection failed that cycle, so its old rows were preserved (not pruned) rather than
    # refreshed. Must be demoted (stale_inventory_data guard), not trusted as confirmed-current,
    # and — because it's still returned — protected from being wrongly resolved.
    old = _NOW - timedelta(hours=25)
    conn = FakeConn([("vol-4", "ap-northeast-2",
                       {"state": "available", "size": 20, "volume_type": "gp3"}, old)])
    out = rules.ebs_unattached(conn, [0])
    assert len(out) == 1
    assert out[0]["stale"] is True
    assert out[0]["resource_id"] == "vol-4"  # still returned (protected from resolve_stale)


def test_ebs_unattached_row_within_threshold_is_not_flagged_stale():
    recent = _NOW - timedelta(hours=1)
    conn = FakeConn([("vol-5", "ap-northeast-2", {"state": "available", "size": 20, "volume_type": "gp3"}, recent)])
    out = rules.ebs_unattached(conn, [0])
    assert out[0]["stale"] is False


def test_ebs_unattached_raises_when_sync_never_ran():
    # steampipe_enabled=false (or inv_sync never ran for this type) -> no inventory_sync_runs row
    # at all, not "confirmed none unattached". Must raise so engine.run() skips resolve_stale.
    conn = FakeConn([], sync_run='missing')
    try:
        rules.ebs_unattached(conn, [0])
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert "no row" in str(e)


def test_ebs_unattached_raises_when_last_sync_failed():
    conn = FakeConn([], sync_run='failed')
    try:
        rules.ebs_unattached(conn, [0])
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert "failed" in str(e)


def test_ebs_unattached_raises_when_sync_is_stale():
    stale_at = datetime.now(timezone.utc) - timedelta(hours=25)
    conn = FakeConn([("vol-1", "ap-northeast-2", {"state": "available", "size": 10, "volume_type": "gp3"})],
                     sync_run=stale_at)
    try:
        rules.ebs_unattached(conn, [0])
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert "stale" in str(e) or "ago" in str(e)


def test_ebs_unattached_ok_when_sync_succeeded_and_genuinely_found_nothing():
    # A HEALTHY, RECENT succeeded sync with zero unattached volumes is a real, trustworthy empty
    # result (e.g. an account with no EBS volumes at all) — must NOT be misclassified as
    # "unavailable", or a genuinely-fixed finding would never resolve (this is the exact regression
    # a prior version of this check introduced by judging freshness from inventory_resources row
    # counts instead of the inventory_sync_runs ledger).
    conn = FakeConn([], sync_run='ok')
    assert rules.ebs_unattached(conn, [0]) == []


class FakeCOPaged:
    """Serves `pages` in order per call; each page is a dict with the raw API response shape."""
    def __init__(self, ec2_pages=None, rds_pages=None, ec2_exc=None, rds_exc=None):
        self.ec2_pages = list(ec2_pages or [])
        self.rds_pages = list(rds_pages or [])
        self.ec2_exc = ec2_exc
        self.rds_exc = rds_exc
        self.ec2_calls = []
        self.rds_calls = []

    def get_ec2_instance_recommendations(self, **kw):
        self.ec2_calls.append(kw)
        if self.ec2_exc:
            raise self.ec2_exc
        return self.ec2_pages.pop(0)

    def get_rds_database_recommendations(self, **kw):
        self.rds_calls.append(kw)
        if self.rds_exc:
            raise self.rds_exc
        return self.rds_pages.pop(0)


def _ec2_page(arn, finding="OVER_PROVISIONED", next_token=None, savings=42.5):
    page = {"instanceRecommendations": [
        {"instanceArn": arn, "currentInstanceType": "m5.xlarge", "finding": finding,
         "instanceName": "web-1", "tags": [{"key": "Team", "value": "core"}],
         "recommendationOptions": [{"instanceType": "m5.large",
                                    "estimatedMonthlySavings": {"value": savings}, "performanceRisk": 1}]},
    ]}
    if next_token:
        page["nextToken"] = next_token
    return page


def test_ec2_rightsizing_uses_top_option_and_skips_optimized(monkeypatch):
    fake = FakeCOPaged(ec2_pages=[{
        "instanceRecommendations": [
            _ec2_page("arn:aws:ec2:1")["instanceRecommendations"][0],
            {"instanceArn": "arn:aws:ec2:2", "currentInstanceType": "t3.micro", "finding": "OPTIMIZED",
             "recommendationOptions": []},
        ],
    }])
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    out = rules.ec2_rightsizing(None, [0])
    assert len(out) == 1
    f = out[0]
    assert f["resource_id"] == "arn:aws:ec2:1"
    assert f["monthly_savings_usd"] == 42.5
    assert f["tags"] == {"Team": "core"}


def test_ec2_rightsizing_follows_pagination_across_multiple_pages(monkeypatch):
    fake = FakeCOPaged(ec2_pages=[
        _ec2_page("arn:aws:ec2:1", next_token="p2"),
        _ec2_page("arn:aws:ec2:2"),
    ])
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    out = rules.ec2_rightsizing(None, [0])
    assert {f["resource_id"] for f in out} == {"arn:aws:ec2:1", "arn:aws:ec2:2"}
    assert len(fake.ec2_calls) == 2
    assert fake.ec2_calls[1]["nextToken"] == "p2"


def test_ec2_rightsizing_stops_at_the_page_safety_bound(monkeypatch):
    # Every page hands back a nextToken forever -> must stop at _CO_MAX_PAGES, not loop forever.
    pages = [_ec2_page(f"arn:{i}", next_token="more") for i in range(10)]
    fake = FakeCOPaged(ec2_pages=pages)
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    rules.ec2_rightsizing(None, [0])
    assert len(fake.ec2_calls) == rules._CO_MAX_PAGES


def test_ec2_rightsizing_degrades_to_empty_on_not_opted_in(monkeypatch):
    fake = FakeCOPaged(ec2_exc=Exception("An error occurred (OptInRequiredException) ..."))
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    assert rules.ec2_rightsizing(None, [0]) == []


def test_ec2_rightsizing_reraises_unexpected_errors_instead_of_degrading(monkeypatch):
    # This is the core fix: a transient failure must NOT look identical to "zero recommendations"
    # (engine.run's resolve_stale would otherwise wipe yesterday's real findings).
    fake = FakeCOPaged(ec2_exc=RuntimeError("ThrottlingException: rate exceeded"))
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    try:
        rules.ec2_rightsizing(None, [0])
        assert False, "expected the exception to propagate"
    except RuntimeError:
        pass


def test_rds_rightsizing_paginates_and_skips_no_option_rows(monkeypatch):
    fake = FakeCOPaged(rds_pages=[
        {"instanceRecommendations": []} | {"rdsDatabaseRecommendations": [
            {"resourceArn": "arn:aws:rds:1", "currentDBInstanceClass": "db.m5.large", "engine": "postgres",
             "recommendationOptions": [{"dbInstanceClass": "db.m5.medium", "estimatedMonthlySavings": {"value": 10.0}}]},
            {"resourceArn": "arn:aws:rds:2", "recommendationOptions": []},
        ], "nextToken": "p2"},
        {"rdsDatabaseRecommendations": [
            {"resourceArn": "arn:aws:rds:3", "currentDBInstanceClass": "db.r5.large", "engine": "mysql",
             "recommendationOptions": [{"dbInstanceClass": "db.r5.medium", "estimatedMonthlySavings": {"value": 5.0}}]},
        ]},
    ])
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    out = rules.rds_rightsizing(None, [0])
    assert {f["resource_id"] for f in out} == {"arn:aws:rds:1", "arn:aws:rds:3"}
    assert len(fake.rds_calls) == 2


def test_rds_rightsizing_degrades_to_empty_on_access_denied(monkeypatch):
    fake = FakeCOPaged(rds_exc=Exception("An error occurred (AccessDeniedException) ..."))
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    assert rules.rds_rightsizing(None, [0]) == []


def test_rds_rightsizing_reraises_unexpected_errors(monkeypatch):
    fake = FakeCOPaged(rds_exc=RuntimeError("ServiceUnavailable"))
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    try:
        rules.rds_rightsizing(None, [0])
        assert False, "expected the exception to propagate"
    except RuntimeError:
        pass


def test_ec2_and_rds_failures_are_independent():
    """A failure fetching one resource class must not prevent evaluating the other — they are two
    separate catalog rules now, not one combined function."""
    from finops import catalog
    ids = {r["id"] for r in catalog.active_rules()}
    assert "ec2_rightsizing" in ids
    assert "rds_rightsizing" in ids
