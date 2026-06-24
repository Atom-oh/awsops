"""g-01 / g-02 read-only inventory additions: Steampipe QUERIES for ecs_service and
ebs_snapshot. Validates registry membership, key columns, id/region cols, and (for snapshots)
the owner-id pushdown guard that keeps DescribeSnapshots from fetching public AWS snapshots."""
import sync_lambda  # PYTHONPATH must include scripts/v2/steampipe


def test_ecs_service_registered():
    assert "ecs_service" in sync_lambda.QUERIES
    assert "ecs_service" in sync_lambda._ALLOWED
    sql, id_col, region_col = sync_lambda.QUERIES["ecs_service"]
    assert "aws_ecs_service" in sql
    for col in ("desired_count", "running_count", "pending_count", "launch_type", "status"):
        assert col in sql, col
    assert "service_name" in sql  # selected for display, but NOT the id (see below)
    # id MUST be the ARN: ECS service names are unique only within a cluster, so two clusters
    # in one account/region can share a service name and would collide on service_name.
    assert id_col == "arn"
    assert region_col == "region"


def test_ebs_snapshot_registered_with_literal_owner_pushdown():
    assert "ebs_snapshot" in sync_lambda.QUERIES
    assert "ebs_snapshot" in sync_lambda._ALLOWED
    sql, id_col, region_col = sync_lambda.QUERIES["ebs_snapshot"]
    assert "aws_ebs_snapshot" in sql
    # The owner_id qual MUST be a LITERAL constant for Steampipe to push OwnerIds=self down to
    # DescribeSnapshots. A subquery/bound-param qual is evaluated by the FDW at execution time
    # and does NOT push down → Steampipe would fetch every public AWS snapshot (throttle/OOM).
    # So the query carries a {account_id} placeholder that sync() renders to a literal.
    assert "owner_id = '{account_id}'" in sql
    assert "aws_caller_identity" not in sql  # subquery form removed (would not push down)
    for col in ("volume_id", "volume_size", "state", "encrypted", "start_time"):
        assert col in sql, col
    assert id_col == "snapshot_id"
    assert region_col == "region"


def test_inject_account_embeds_literal():
    sql = sync_lambda.QUERIES["ebs_snapshot"][0]
    rendered = sync_lambda._inject_account(sql, "123456789012")
    assert "owner_id = '123456789012'" in rendered
    assert "{account_id}" not in rendered


def test_inject_account_rejects_non_account_literal():
    import pytest
    # defense in depth: never interpolate anything that is not a 12-digit account id
    with pytest.raises(ValueError):
        sync_lambda._inject_account("WHERE owner_id = '{account_id}'", "'; DROP TABLE x--")


def test_inject_account_noop_without_placeholder():
    plain = "SELECT name FROM aws_s3_bucket"
    assert sync_lambda._inject_account(plain, "bogus") == plain
