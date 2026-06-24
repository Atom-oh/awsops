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
    assert id_col == "service_name"
    assert region_col == "region"
