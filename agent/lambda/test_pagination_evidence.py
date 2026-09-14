"""Offline producer pagination contracts: no continuation requests or token disclosure."""
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import aws_iam_mcp as iam
import aws_dynamodb_mcp as ddb
import aws_finops_mcp as finops
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tool_receipts import terminal


@pytest.mark.parametrize("tool,key", [
    ("list_users", "Users"), ("list_roles", "Roles"), ("list_groups", "Groups"), ("list_policies", "Policies"),
])
@pytest.mark.parametrize("flag,expected,unknown", [
    (False, False, False), (True, True, False), (None, False, True), ("false", False, True), (0, False, True),
])
def test_iam_one_page_flags_are_typed_and_no_marker_is_returned(tool, key, flag, expected, unknown):
    client = MagicMock()
    getattr(client, tool).return_value = {key: [], "IsTruncated": flag, "Marker": "PRIVATE"}
    with patch.object(iam, "get_client", return_value=client):
        body = json.loads(iam.lambda_handler({"tool_name": tool, "arguments": {}}, None)["body"])
    assert body["truncated"] is expected
    assert body.get("unknown", False) is unknown
    assert "PRIVATE" not in json.dumps(body)
    getattr(client, tool).assert_called_once()
    assert terminal({"status": "success", "content": [{"json": body}]}, tool=tool)[0] == (
        "partial" if expected or unknown else "empty")


@pytest.mark.parametrize("tool,token_key,tokens", [
    ("list_tables", "LastEvaluatedTableName", [(None, False, False), ("", False, False), ("PRIVATE", True, False), (True, False, True)]),
    ("query_table", "LastEvaluatedKey", [(None, False, False), ({}, False, False), ({"id": "PRIVATE"}, True, False), ("PRIVATE", False, True)]),
    ("scan_table", "LastEvaluatedKey", [(None, False, False), ({}, False, False), ({"id": "PRIVATE"}, True, False), (False, False, True)]),
])
def test_dynamodb_empty_results_with_continuation_and_bad_tokens(tool, token_key, tokens):
    for token, expected, unknown in tokens:
        client, resource = MagicMock(), MagicMock()
        response = {"TableNames": [], "Items": [], "Count": 0, "ScannedCount": 42}
        if token is not None:
            response[token_key] = token
        client.list_tables.return_value = response
        resource.Table.return_value.scan.return_value = response
        with patch.object(ddb, "get_client", return_value=client), patch.object(ddb, "get_resource", return_value=resource):
            body = json.loads(ddb.lambda_handler({"tool_name": tool, "arguments": {"table_name": "fixture"}}, None)["body"])
        assert body["truncated"] is expected
        assert body.get("unknown", False) is unknown
        assert "PRIVATE" not in json.dumps(body)
        assert terminal({"status": "success", "content": [{"json": body}]}, tool=tool)[0] == (
            "partial" if expected or unknown else "empty")
        if tool == "list_tables":
            client.list_tables.assert_called_once()
        else:
            resource.Table.return_value.scan.assert_called_once()


@pytest.mark.parametrize("tool,limit", [("list_tables", 20), ("query_table", 50), ("scan_table", 50)])
def test_dynamodb_local_slice_also_marks_truncated(tool, limit):
    client, resource = MagicMock(), MagicMock()
    client.list_tables.return_value = {"TableNames": ["fixture"] * (limit + 1)}
    client.describe_table.return_value = {"Table": {"TableStatus": "ACTIVE"}}
    resource.Table.return_value.scan.return_value = {
        "Items": [{"id": "fixture"}] * (limit + 1), "Count": limit + 1, "ScannedCount": limit + 1,
    }
    with patch.object(ddb, "get_client", return_value=client), patch.object(ddb, "get_resource", return_value=resource):
        body = json.loads(ddb.lambda_handler({"tool_name": tool, "arguments": {"table_name": "fixture"}}, None)["body"])
    assert body["truncated"] is True
    assert len(body["tables" if tool == "list_tables" else "items"]) == limit
    assert body["count"] == limit + 1
    assert client.describe_table.call_count <= 20


def test_dynamodb_key_query_preserves_continuation_without_a_second_request():
    client, resource = MagicMock(), MagicMock()
    resource.Table.return_value.query.return_value = {
        "Items": [], "Count": 0, "LastEvaluatedKey": {"id": "PRIVATE"},
    }
    with patch.object(ddb, "get_client", return_value=client), patch.object(ddb, "get_resource", return_value=resource):
        body = json.loads(ddb.lambda_handler({"tool_name": "query_table", "arguments": {
            "table_name": "fixture", "key_condition": {"key": "id", "value": "fixture"},
        }}, None)["body"])
    resource.Table.return_value.query.assert_called_once()
    resource.Table.return_value.scan.assert_not_called()
    assert body["truncated"] is True
    assert "PRIVATE" not in json.dumps(body)


@pytest.mark.parametrize("size", [0, 1, 15, 16])
def test_trusted_advisor_discloses_the_existing_check_cap(size):
    client = MagicMock()
    client.describe_trusted_advisor_checks.return_value = {
        "checks": [{"id": str(i), "name": "fixture", "category": "cost_optimizing"} for i in range(size)],
    }
    client.describe_trusted_advisor_check_result.return_value = {"result": {
        "status": "ok", "flaggedResources": [], "resourcesSummary": {},
    }}
    with patch.object(finops, "get_client", return_value=client):
        body = json.loads(finops.lambda_handler({
            "tool_name": "get_trusted_advisor_cost_checks", "arguments": {},
        }, None)["body"])
    assert body["truncated"] is (size > 15)
    assert body["totalEstimatedMonthlySavings"] == (None if size > 15 else 0)
    assert client.describe_trusted_advisor_check_result.call_count == min(size, 15)
    assert terminal({"status": "success", "content": [{"json": body}]},
                    tool="get_trusted_advisor_cost_checks")[0] == (
        "partial" if size > 15 else "success" if size else "empty")


def test_trusted_advisor_failed_checks_do_not_return_a_zero_savings_total():
    client = MagicMock()
    client.describe_trusted_advisor_checks.return_value = {
        "checks": [{"id": "fixture", "category": "cost_optimizing"}],
    }
    client.describe_trusted_advisor_check_result.side_effect = PermissionError("PRIVATE")
    with patch.object(finops, "get_client", return_value=client):
        body = json.loads(finops.lambda_handler({
            "tool_name": "get_trusted_advisor_cost_checks", "arguments": {},
        }, None)["body"])
    assert body["totalEstimatedMonthlySavings"] is None
    assert "PRIVATE" not in json.dumps(body)
