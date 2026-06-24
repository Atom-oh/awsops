import importlib.util
import sys
import types
from pathlib import Path


def load_sync_lambda():
    root = Path(__file__).resolve().parent
    sys.modules.setdefault("boto3", types.SimpleNamespace(client=lambda *a, **k: object()))
    sys.modules.setdefault("pg8000", types.SimpleNamespace(native=types.SimpleNamespace(Connection=object)))
    sys.modules.setdefault("pg8000.native", types.SimpleNamespace(Connection=object))
    sys.modules.setdefault("botocore", types.SimpleNamespace())
    sys.modules.setdefault("botocore.exceptions", types.SimpleNamespace(ClientError=Exception))
    spec = importlib.util.spec_from_file_location("sync_lambda_under_test", root / "sync_lambda.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


def test_ecs_service_query_registered_readonly():
    mod = load_sync_lambda()
    sql, id_col, region_col = mod.QUERIES["ecs_service"]
    assert "FROM aws_ecs_service" in sql
    assert id_col == "service_arn"
    assert region_col == "region"
    for col in [
        "service_arn", "service_name", "cluster_arn", "status",
        "desired_count", "running_count", "pending_count",
        "launch_type", "scheduling_strategy", "task_definition", "created_at",
    ]:
        assert col in sql
