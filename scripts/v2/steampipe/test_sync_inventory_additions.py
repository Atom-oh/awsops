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


def test_ebs_snapshot_registered_with_owner_pushdown():
    assert "ebs_snapshot" in sync_lambda.QUERIES
    assert "ebs_snapshot" in sync_lambda._ALLOWED
    sql, id_col, region_col = sync_lambda.QUERIES["ebs_snapshot"]
    assert "aws_ebs_snapshot" in sql
    # owner-id pushdown guard: OwnerIds=self must be pushed to DescribeSnapshots, else
    # Steampipe fetches every public AWS snapshot (hundreds of thousands → throttle/OOM).
    assert "owner_id" in sql
    assert "aws_caller_identity" in sql
    for col in ("volume_id", "volume_size", "state", "encrypted", "start_time"):
        assert col in sql, col
    assert id_col == "snapshot_id"
    assert region_col == "region"
