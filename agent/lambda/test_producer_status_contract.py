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
