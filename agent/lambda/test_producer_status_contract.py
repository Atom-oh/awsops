"""Real producer -> receipt contracts with offline upstream responses."""
import copy
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
import prometheus_mcp as prom
import mimir_mcp as mimir
import loki_mcp as loki
import tempo_mcp as tempo
import notion_mcp as notion
import opensearch_mcp as search

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tool_receipts import terminal

PAGE = {"object": "page", "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}
LIST_TOOLS = [
    (prom, "prometheus_labels", "labels", "job", 1000),
    (prom, "prometheus_series", "series", {"job": "fixture"}, 50),
    (mimir, "mimir_labels", "labels", "job", 1000),
    (mimir, "mimir_series", "series", {"job": "fixture"}, 50),
    (loki, "loki_labels", "labels", "job", 1000),
    (loki, "loki_label_values", "values", "fixture", 1000),
]


def receipt(tool, response):
    outcome, quality, _ = terminal({"status": "success", "content": [{"json": response}]},
                                   tool="producer___" + tool)
    assert "PRIVATE" not in json.dumps(quality)
    assert "UPSTREAM_SECRET" not in json.dumps(quality)
    return outcome


@pytest.mark.parametrize("module,tool,field,row,limit", LIST_TOOLS)
@pytest.mark.parametrize("mode,expected", [
    ("empty", "empty"), ("rows", "success"), ("missing_status", "unverified"),
    ("missing_data", "unverified"), ("null", "unverified"), ("object", "unverified"),
    ("raw_list", "unverified"), ("pending", "error"), ("truncated", "partial"), ("mixed", "partial"),
])
def test_named_list_status_and_shape_survive_unwrapping(module, tool, field, row, limit, mode, expected):
    data = {"status": "success", "data": []}
    if mode == "rows":
        data["data"] = [row]
    elif mode == "missing_status":
        del data["status"]
    elif mode == "missing_data":
        del data["data"]
    elif mode == "null":
        data["data"] = None
    elif mode == "object":
        data["data"] = {"error": "UPSTREAM_SECRET"}
    elif mode == "raw_list":
        data = []
    elif mode == "pending":
        data["status"] = "running"
    elif mode == "truncated":
        data["data"] = [row] * (limit + 1)
    elif mode == "mixed":
        data["data"] = [row, None]
    with patch.object(module, "_ds", return_value={"endpoint": "https://fixture.invalid"}), \
            patch.object(module, "http_json", return_value=(200, data)) as http:
        out = module.lambda_handler({"tool_name": tool, "arguments": {"match": "up", "label": "job"}}, None)
    http.assert_called_once()
    body = json.loads(out["body"])
    assert receipt(tool, out) == expected
    if out["statusCode"] == 200:
        assert body["collectionStatus"] in ("ok", "empty", "partial", "unknown")
        assert type(body["truncated"]) is bool
        assert len(body[field]) <= limit
        if mode in ("rows", "mixed"):
            assert row in body[field]
        assert "UPSTREAM_SECRET" not in json.dumps(body)


@pytest.mark.parametrize("data,expected", [
    ({"traces": []}, "empty"), ({"traces": [{"traceID": "a1"}]}, "success"),
    ({}, "unverified"), ({"traces": None}, "unverified"), ({"traces": {}}, "unverified"),
    ([], "unverified"), ({"traces": [{"traceID": "a1"}] * 51}, "partial"),
])
def test_tempo_omitted_protobuf_list_is_unknown_not_confirmed_empty(data, expected):
    if isinstance(data, dict):
        data = {**data, "metrics": {"inspectedBytes": 17}}
    with patch.object(tempo, "_ds", return_value={"endpoint": "https://fixture.invalid"}), \
            patch.object(tempo, "http_json", return_value=(200, data)) as http:
        out = tempo.lambda_handler({"tool_name": "tempo_search", "arguments": {"query": "{}"}}, None)
    http.assert_called_once()
    body = json.loads(out["body"])
    assert receipt("tempo_search", out) == expected
    assert body["collectionStatus"] in ("ok", "empty", "partial", "unknown")
    if isinstance(data, dict):
        assert body["metrics"] == data["metrics"]
    assert len(body["traces"]) <= tempo.MAX_TRACES


@pytest.mark.parametrize("change,expected", [
    ({}, "empty"), ({"timed_out": True}, "partial"), ({"_shards": {"failed": 1}}, "partial"),
    ({"timed_out": None}, "unverified"), ({"_shards": {}}, "unverified"),
    ({"_shards": {"failed": True}}, "unverified"), ({"hits": {}}, "unverified"),
])
def test_opensearch_timeout_and_failed_shards_cannot_be_erased(change, expected):
    data = {"timed_out": False, "_shards": {"failed": 0},
            "hits": {"total": {"value": 0, "relation": "eq"}, "hits": []}, **change}
    with patch.object(search, "_resolve_endpoint", return_value="https://fixture.invalid"), \
            patch.object(search, "_signed_request", return_value=(200, data)) as http:
        out = search.search_opensearch_logs({"domain": "fixture"}, "ap-northeast-2", None)
    http.assert_called_once()
    body = json.loads(out["body"])
    assert receipt("search_opensearch_logs", out) == expected
    assert body["timedOut"] is (change["timed_out"] if "timed_out" in change else False)
    if "_shards" in change and ("failed" not in change["_shards"] or type(change["_shards"]["failed"]) is bool):
        assert body["failedShards"] is None
    assert "collectionStatus" in body


def test_opensearch_partial_hits_preserved_and_missing_flags_not_defaulted():
    hit = {"_id": "fixture", "_source": {"message": "PRIVATE useful result"}}
    for missing, expected in [(False, "partial"), (True, "unverified")]:
        data = {"hits": {"total": {"value": 1, "relation": "eq"}, "hits": [hit]}}
        if not missing:
            data.update(timed_out=True, _shards={"failed": 0})
        with patch.object(search, "_resolve_endpoint", return_value="https://fixture.invalid"), \
                patch.object(search, "_signed_request", return_value=(200, data)):
            out = search.search_opensearch_logs({"domain": "fixture"}, "ap-northeast-2", None)
        body = json.loads(out["body"])
        assert body["hits"][0]["_source"] == hit["_source"]
        assert receipt("search_opensearch_logs", out) == expected
        if missing:
            assert body["timedOut"] is None and body["failedShards"] is None


@pytest.mark.parametrize("tool", ["notion_search", "notion_query_database"])
@pytest.mark.parametrize("data,expected", [
    ({"results": [], "has_more": False}, "empty"),
    ({"results": [PAGE], "has_more": False}, "success"),
    ({"results": [PAGE], "has_more": True}, "partial"),
    ({}, "unverified"), ({"results": []}, "unverified"), ({"has_more": False}, "unverified"),
    ({"results": None, "has_more": False}, "unverified"),
    ({"results": [], "has_more": "false"}, "unverified"),
    ({"results": [PAGE]}, "unverified"),
])
def test_notion_results_and_pagination_must_be_observed(tool, data, expected):
    with patch.object(notion, "_get_token", return_value="PRIVATE"), \
            patch.object(notion, "_http_json", return_value=(200, copy.deepcopy(data))) as http:
        out = notion.lambda_handler({"tool_name": tool, "arguments": {"query": "x", "database_id": PAGE["id"]}}, None)
    http.assert_called_once()
    body = json.loads(out["body"])
    assert receipt(tool, out) == expected
    assert body["collectionStatus"] in ("ok", "empty", "partial", "unknown")
    if data.get("results"):
        assert body["results"] == data["results"]


@pytest.mark.parametrize("children,status,expected", [
    ({"results": [], "has_more": False}, 200, "success"),
    ({}, 200, "partial"), ({"results": []}, 200, "partial"),
    ({"results": None, "has_more": False}, 200, "partial"),
    ({"error": "UPSTREAM_SECRET"}, 403, "partial"),
])
def test_notion_valid_page_survives_incomplete_or_failed_block_collection(children, status, expected):
    with patch.object(notion, "_get_token", return_value="PRIVATE"), \
            patch.object(notion, "_http_json", side_effect=[(200, PAGE), (status, children)]) as http:
        out = notion.lambda_handler({"tool_name": "notion_fetch_page", "arguments": {"page_id": PAGE["id"]}}, None)
    assert http.call_count == 2
    body = json.loads(out["body"])
    assert body["page"] == PAGE
    assert body["collectionStatus"] == "ok"
    assert body["blocksCollectionStatus"] in ("empty", "unknown", "error")
    assert "UPSTREAM_SECRET" not in json.dumps(body)
    assert receipt("notion_fetch_page", out) == expected


@pytest.mark.parametrize("page", [{}, [], {"object": "error", "message": "UPSTREAM_SECRET"}])
def test_notion_unknown_page_cannot_be_certified_by_empty_blocks(page):
    with patch.object(notion, "_get_token", return_value="PRIVATE"), \
            patch.object(notion, "_http_json", side_effect=[(200, page), (200, {"results": [], "has_more": False})]):
        out = notion.lambda_handler({"tool_name": "notion_fetch_page", "arguments": {"page_id": PAGE["id"]}}, None)
    assert receipt("notion_fetch_page", out) == "unverified"


@pytest.mark.parametrize("tool", ["loki_query", "loki_query_range"])
@pytest.mark.parametrize("mode,expected", [
    ("empty", "empty"), ("rows", "success"), ("default_cap", "partial"),
    ("custom_cap", "partial"), ("below_custom_cap", "success"), ("missing_status", "unverified"),
    ("missing_kind", "unverified"), ("malformed_values", "unverified"), ("missing_data", "unverified"),
    ("vector", "success"), ("matrix", "success"), ("malformed_matrix", "unverified"), ("pending", "error"),
])
def test_loki_query_source_status_and_server_line_cap(tool, mode, expected):
    row = {"stream": {"job": "fixture"}, "values": [["1700000000000000000", "PRIVATE log"]]}
    data = {"status": "success", "data": {"resultType": "streams", "result": []}}
    args = {"query": "PRIVATE query"}
    if mode in ("rows", "default_cap", "custom_cap", "below_custom_cap", "malformed_values"):
        data["data"]["result"] = [copy.deepcopy(row)]
    if mode == "default_cap":
        data["data"]["result"][0]["values"] *= 100
    elif mode in ("custom_cap", "below_custom_cap"):
        args["limit"] = 1 if mode == "custom_cap" else 2
    elif mode == "missing_status":
        del data["status"]
    elif mode == "missing_kind":
        del data["data"]["resultType"]
    elif mode == "malformed_values":
        data["data"]["result"][0]["values"] = [["1700000000000000000", None]]
    elif mode == "missing_data":
        del data["data"]
    elif mode in ("vector", "matrix", "malformed_matrix"):
        values = {"value": [1, "2"]} if mode == "vector" else {"values": [[1, "2"]]}
        data["data"] = {"resultType": "matrix" if mode == "malformed_matrix" else mode, "result": [{"metric": {}, **values}]}
        if mode == "malformed_matrix":
            data["data"]["result"][0]["values"][0][1] = None
        args["limit"] = 1  # the Loki log-line limit does not cap metric results
    elif mode == "pending":
        data["status"] = "running"
    with patch.object(loki, "_ds", return_value={"endpoint": "https://fixture.invalid"}), \
            patch.object(loki, "http_json", return_value=(200, data)) as http:
        out = loki.lambda_handler({"tool_name": tool, "arguments": args}, None)
    http.assert_called_once()
    assert receipt(tool, out) == expected
    if out["statusCode"] == 200:
        body = json.loads(out["body"])
        assert body["collectionStatus"] in ("ok", "empty", "partial", "unknown")
        if mode in ("rows", "default_cap", "custom_cap", "below_custom_cap"):
            assert body["result"][0]["values"][0] == row["values"][0]


@pytest.mark.parametrize("values", [[], [{"Value": "PRIVATE service"}]])
def test_cost_dimension_actual_producer_drops_continuation_but_receipt_stays_partial(values):
    import aws_cost_mcp as cost
    from unittest.mock import Mock
    client = Mock()
    client.get_dimension_values.return_value = {"DimensionValues": values, "NextPageToken": "PRIVATE token"}
    with patch.object(cost, "get_client", return_value=client):
        out = cost.lambda_handler({"tool_name": "get_dimension_values", "arguments": {}}, None)
    client.get_dimension_values.assert_called_once()
    assert receipt("get_dimension_values", out) == "partial"


@pytest.mark.parametrize("module,tool", [(prom, "prometheus_query"), (prom, "prometheus_query_range"),
                                          (mimir, "mimir_query"), (mimir, "mimir_query_range")])
@pytest.mark.parametrize("populated", [False, True])
@pytest.mark.parametrize("mode", ["clean", "warnings", "malformed_warnings", "missing_status", "missing_data", "pending", "capped"])
def test_metric_query_warnings_survive_upstream_projection(module, tool, populated, mode):
    row = {"metric": {"job": "PRIVATE"}, "value": [1, "2"]}
    rows = [row] if populated else []
    upstream = {"status": "success", "data": {"resultType": "vector", "result": rows}}
    expected = "success" if populated else "empty"
    if mode == "warnings":
        upstream["warnings"] = ["UPSTREAM_SECRET partial remote read"]
        expected = "partial"
    elif mode == "malformed_warnings":
        upstream["warnings"] = None
        expected = "unverified"
    elif mode == "missing_status":
        del upstream["status"]
        expected = "unverified"
    elif mode == "missing_data":
        del upstream["data"]
        expected = "unverified"
    elif mode == "pending":
        upstream["status"] = "running"
        expected = "error"
    elif mode == "capped":
        upstream["data"]["result"] = [row] * 51
        expected = "partial"
    with patch.object(module, "_ds", return_value={"endpoint": "https://fixture.invalid"}), \
            patch.object(module, "http_json", return_value=(200, upstream)) as http:
        out = module.lambda_handler({"tool_name": tool, "arguments": {"query": "PRIVATE query"}}, None)
    http.assert_called_once()
    assert receipt(tool, out) == expected
    if out["statusCode"] == 200:
        body = json.loads(out["body"])
        assert body["collectionStatus"] in ("ok", "empty", "partial", "unknown")
        assert "UPSTREAM_SECRET" not in json.dumps(body)
        if mode not in ("missing_data", "capped"):
            assert body["result"] == rows


@pytest.mark.parametrize("module,tool", [(prom, "prometheus_labels"), (mimir, "mimir_labels")])
def test_shared_metric_api_status_also_preserves_named_list_warnings(module, tool):
    with patch.object(module, "_ds", return_value={"endpoint": "https://fixture.invalid"}), \
            patch.object(module, "http_json", return_value=(200, {
                "status": "success", "data": [], "warnings": ["UPSTREAM_SECRET incomplete"],
            })) as http:
        out = module.lambda_handler({"tool_name": tool, "arguments": {}}, None)
    http.assert_called_once()
    assert receipt(tool, out) == "partial"
    assert "UPSTREAM_SECRET" not in out["body"]


@pytest.mark.parametrize("resource_type", ["target_group", "alb", "nlb", "cloudfront", "ebs", "ec2", "ecs"])
@pytest.mark.parametrize("n", [0, 1])
def test_inventory_actual_projection_disclosure_restricts_receipt(resource_type, n):
    import inventory_read_mcp as inventory
    stamp = "2026-09-14 00:00:00"
    freshness = {"resource_type": resource_type, "freshness": "healthy", "current_count": n,
                 "status": "succeeded", "row_count": n, "last_success_row_count": n,
                 "unknown_attribute_count": 0, "latest_success_at": stamp,
                 "last_success_at": stamp, "finished_at": stamp}
    rows = [{key: "PRIVATE" for key in inventory.PROJECTIONS.get(resource_type, [])}] * n
    with patch.object(inventory, "_fetch_one_type", return_value=rows) as fetch, \
            patch.object(inventory, "_freshness_for_type", return_value=freshness) as ledger:
        out = inventory.lambda_handler({"tool_name": "query_inventory", "arguments": {"resource_type": resource_type}}, None)
    fetch.assert_called_once()
    ledger.assert_called_once()
    body = json.loads(out["body"])
    expected = ("success" if n else "empty") if resource_type in inventory.PROJECTIONS else "partial"
    assert receipt("query_inventory", out) == expected
    if resource_type not in inventory.PROJECTIONS:
        assert "limited by the sql_reader" in body["note"]
        del body["note"]  # Classification uses the type contract, not free-form prose.
        assert receipt("query_inventory", {"statusCode": 200, "body": json.dumps(body)}) == "partial"


@pytest.mark.parametrize("limit,n,metrics,expected", [
    (None, 20, {}, "partial"), (None, 19, {}, "success"), (None, 0, {}, "empty"),
    (1, 1, {}, "partial"), (2, 1, {}, "success"),
    (2, 0, {"completedJobs": 1, "totalJobs": 2}, "partial"),
    (2, 1, {"completedJobs": 1, "totalJobs": 2}, "partial"),
    (2, 0, {"completedJobs": 2, "totalJobs": 2}, "empty"),
    (2, 0, {"inspectedBytes": 17}, "empty"),
    (2, 0, {"totalJobs": 2}, "unverified"),
    (2, 0, {"completedJobs": None, "totalJobs": 2}, "unverified"),
    (2, 0, {"completedJobs": "2", "totalJobs": 2}, "unverified"),
    (2, 0, {"completedJobs": True, "totalJobs": 2}, "unverified"),
    (2, 0, {"completedJobs": 2}, "unverified"),
    (2, 0, {"completedJobs": 2, "totalJobs": None}, "unverified"),
    (2, 0, {"completedJobs": -1, "totalJobs": 2}, "unverified"),
    (2, 0, {"completedJobs": 0, "totalJobs": 0}, "empty"),
    (2, 0, {"completedJobs": 3, "totalJobs": 2}, "unverified"),
    (2, 1, {"completedJobs": 2, "totalJobs": 2}, "success"),
    ("invalid", 0, {}, "unverified"),
])
def test_tempo_effective_search_limit_and_incomplete_jobs(limit, n, metrics, expected):
    from urllib.parse import parse_qs, urlparse
    args = {"query": "PRIVATE query"}
    if limit is not None:
        args["limit"] = limit
    data = {"traces": [{"traceID": "a1"}] * n, "metrics": metrics}
    with patch.object(tempo, "_ds", return_value={"endpoint": "https://fixture.invalid"}), \
            patch.object(tempo, "http_json", return_value=(200, data)) as http:
        out = tempo.lambda_handler({"tool_name": "tempo_search", "arguments": args}, None)
    http.assert_called_once()
    params = parse_qs(urlparse(http.call_args.args[1]).query)
    assert params["limit"] == [str(limit if limit is not None else 20)]
    assert receipt("tempo_search", out) == expected
    body = json.loads(out["body"])
    assert body["traces"] == data["traces"]
    assert body["metrics"] == metrics


@pytest.mark.parametrize("module,tool", [(prom, "prometheus_query"), (mimir, "mimir_query")])
@pytest.mark.parametrize("warned", [False, True])
def test_metric_pair_lists_are_not_certified_after_dict_coercion(module, tool, warned):
    raw = [["metric", {}], ["value", [1, "2"]]]
    data = {"status": "success", "data": {"resultType": "vector", "result": [raw]}}
    if warned:
        data["warnings"] = ["UPSTREAM_SECRET"]
    with patch.object(module, "_ds", return_value={"endpoint": "https://fixture.invalid"}), \
            patch.object(module, "http_json", return_value=(200, data)) as http:
        out = module.lambda_handler({"tool_name": tool, "arguments": {"query": "fixture"}}, None)
    http.assert_called_once()
    assert json.loads(out["body"])["collectionStatus"] == "unknown"
    assert receipt(tool, out) == "unverified"


@pytest.mark.parametrize("case", json.loads((Path(__file__).resolve().parents[1] / "fixtures/tempo-topology-contract.json").read_text()), ids=lambda case: case["name"])
def test_tempo_topology_shared_producer_contract(case):
    with patch.object(tempo, "_ds", return_value={"endpoint": "https://fixture.invalid"}), \
            patch.object(tempo, "http_json", return_value=(200, case["upstream"])) as http:
        out = tempo.lambda_handler({"tool_name": "tempo_search", "arguments": {"query": "{}", "limit": 20}}, None)
    http.assert_called_once()
    assert out["statusCode"] == 200
    assert json.loads(out["body"]) == case["body"]
