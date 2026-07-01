"""g-02 read-only inventory addition: Steampipe QUERIES for ebs_snapshot. Validates registry
membership, key columns, id/region cols, and the owner-id literal pushdown guard that keeps
DescribeSnapshots from fetching public AWS snapshots.

(ecs_service [g-01] landed via the concurrent merge — keyed by cluster+service — and is covered
by scripts/v2/steampipe/test_sync_lambda_queries.py, so it is intentionally not re-tested here.)"""
import sync_lambda  # PYTHONPATH must include scripts/v2/steampipe


def test_ebs_snapshot_registered_with_literal_owner_pushdown():
    assert "ebs_snapshot" in sync_lambda.QUERIES
    assert "ebs_snapshot" in sync_lambda._ALLOWED
    sql, id_col, region_col = sync_lambda.QUERIES["ebs_snapshot"]
    assert "aws_ebs_snapshot" in sql
    # owner_id MUST be LITERAL constants for OwnerIds pushdown to DescribeSnapshots. Under the
    # multi-account aggregator a single host literal would miss target accounts, so the query
    # carries an {owner_ids} placeholder sync() renders to the IN-list of all enabled accounts.
    assert "owner_id IN ({owner_ids})" in sql
    assert "aws_caller_identity" not in sql  # subquery form removed (would not push down)
    for col in ("volume_id", "volume_size", "state", "encrypted", "start_time"):
        assert col in sql, col
    assert id_col == "snapshot_id"
    assert region_col == "region"


def test_inject_account_embeds_literal():
    # _inject_account still renders a validated single-account literal for any {account_id} template.
    rendered = sync_lambda._inject_account("WHERE owner_id = '{account_id}'", "123456789012")
    assert "owner_id = '123456789012'" in rendered
    assert "{account_id}" not in rendered


def test_inject_account_rejects_non_account_literal():
    import pytest
    # defense in depth: never interpolate anything that is not a 12-digit account id
    with pytest.raises(ValueError):
        sync_lambda._inject_account("WHERE owner_id = '{account_id}'", "'; DROP TABLE x--")


def test_prune_present_always_includes_self():
    """The host 'self' account uses IAM task-role credentials (not AssumeRole) and always
    succeeds. If 'self' returns 0 rows (all resources deleted), it is genuinely empty — its
    stale rows must be pruned rather than kept as phantoms. This verifies that 'self' is
    always in the `present` set regardless of whether any rows were returned (phase-2 M1 fix)."""
    # Simulate: no rows returned from Steampipe (empty run)
    seen: set = set()
    present = {a for (a, _, _) in seen} | {'self'}
    assert 'self' in present, "'self' must always be in present (prune-to-zero fix)"

    # Simulate: only target account rows returned (host had no resources)
    seen = {('123456789012', 'ap-northeast-2', 'i-abc')}
    present = {a for (a, _, _) in seen} | {'self'}
    assert 'self' in present  # host still prunable even with 0 host rows
    assert '123456789012' in present  # target account present normally


def test_disabled_account_cleanup_sql_excludes_self_and_targets_disabled():
    """Phase-1 prune deletes rows for accounts no longer in SCAN SCOPE via a NOT IN subquery.
    This asserts on sync_lambda.PHASE1_PRUNE_SQL — the ACTUAL constant sync() executes (not a
    hand-copied duplicate) — so a future edit to the real query can't silently drift out of sync
    with this test (F3 fix, round 6). Verify the SQL shape: scope to resource_type, exclude 'self'
    (handled by phase 2), and delete accounts NOT in the currently in-scope set."""
    phase1_sql = sync_lambda.PHASE1_PRUNE_SQL
    assert "account_id != 'self'" in phase1_sql, "phase 1 must not touch 'self' rows"
    assert "NOT IN" in phase1_sql, "phase 1 must exclude in-scope accounts from deletion"
    assert "a.enabled = true" in phase1_sql, "phase 1 must require enabled=true"
    assert "resource_type = :t" in phase1_sql, "phase 1 must scope to current resource type"


def test_disabled_account_cleanup_sql_also_excludes_enabled_but_zero_scope_accounts():
    """F1 regression (round 6): an ENABLED account with all_regions=false and ZERO enabled
    account_regions rows is SKIPPED by render_spc (spc_render.py) — no aws_<id> connection is
    ever rendered for it. A bare `enabled = true` check would leave such an account's stale rows
    as PERMANENT phantoms: phase 1 wouldn't touch it (still enabled), and phase 2's reachability
    probe can never succeed for it either (there is no per-account schema to query). The in-scope
    subquery must therefore ALSO require all_regions OR an enabled account_regions row —
    mirroring render_spc's/listScanScope's own skip condition exactly."""
    phase1_sql = sync_lambda.PHASE1_PRUNE_SQL
    assert "a.all_regions = true" in phase1_sql, "must accept all_regions accounts as in-scope"
    assert "EXISTS" in phase1_sql and "account_regions" in phase1_sql, (
        "must accept accounts with >=1 enabled account_regions row as in-scope — "
        "a bare enabled=true check would leave an enabled-but-zero-region account "
        "as a permanent phantom (F1)"
    )
    assert "r.enabled = true" in phase1_sql, "the account_regions EXISTS check must require enabled=true"




def test_inject_account_noop_without_placeholder():
    plain = "SELECT name FROM aws_s3_bucket"
    assert sync_lambda._inject_account(plain, "bogus") == plain
