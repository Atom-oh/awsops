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
    assert "(cluster_arn || '/' || service_name) AS service_key" in sql
    assert id_col == "service_key"
    assert region_col == "region"
    for col in [
        "service_name", "cluster_arn", "status",
        "desired_count", "running_count", "pending_count",
        "launch_type", "scheduling_strategy", "task_definition", "created_at",
    ]:
        assert col in sql
    assert "service_arn" not in sql


# ── Task 9: multi-account scoping ──

def test_rec_account_uses_row_account_else_self():
    mod = load_sync_lambda()
    assert mod._rec_account({"account_id": "210987654321"}) == "210987654321"
    assert mod._rec_account({"account_id": None}) == "self"   # host / SDK rows without account_id
    assert mod._rec_account({}) == "self"


def test_ebs_snapshot_pushdown_is_multi_account_in_list():
    mod = load_sync_lambda()
    sql, id_col, region_col = mod.QUERIES["ebs_snapshot"]
    # no longer a single host literal; an OwnerIds IN-list rendered from enabled accounts
    assert "owner_id IN ({owner_ids})" in sql
    assert "= '{account_id}'" not in sql


def test_owner_ids_in_includes_host_and_targets_validated():
    mod = load_sync_lambda()
    mod._ACCOUNT_CACHE["id"] = "111111111111"  # bypass STS (host caller)

    class FakeAdb:
        def run(self, *a, **k):
            return [("210987654321",), ("310987654321",), ("self",), ("bad",)]

    clause = mod._owner_ids_in(FakeAdb())
    assert "'111111111111'" in clause   # host real id
    assert "'210987654321'" in clause and "'310987654321'" in clause
    assert "'self'" not in clause and "'bad'" not in clause   # non-12-digit excluded
