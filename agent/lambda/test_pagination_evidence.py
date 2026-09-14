"""Offline producer pagination contracts: no continuation requests or token disclosure."""
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import aws_iam_mcp as iam
import aws_dynamodb_mcp as ddb
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
