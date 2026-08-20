"""Tests for sg_rule_athena_broker.py's defense-in-depth identifier re-validation (L3
trust-boundary finding: the broker must not blindly trust caller-supplied account_id/region/
workgroup/database/table shapes just because a legitimate caller is expected to have validated
them upstream). These are pure-input-shape tests — no AWS calls are made (a malformed identifier
must be rejected BEFORE any AssumeRole/Athena/Glue call is attempted)."""
import pytest

import sg_rule_athena_broker as broker


def test_query_rejects_malformed_account_id():
    with pytest.raises(broker.BrokerError, match="account_id"):
        broker._query({
            "account_id": "not-an-account", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "query": "SELECT 1",
        })


def test_query_rejects_malformed_region():
    with pytest.raises(broker.BrokerError, match="region"):
        broker._query({
            "account_id": "123456789012", "region": "; DROP TABLE x", "workgroup": "wg",
            "database": "db", "query": "SELECT 1",
        })


def test_query_rejects_malformed_workgroup():
    with pytest.raises(broker.BrokerError, match="workgroup"):
        broker._query({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg; DROP",
            "database": "db", "query": "SELECT 1",
        })


def test_query_rejects_malformed_database():
    with pytest.raises(broker.BrokerError, match="database"):
        broker._query({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db-with-hyphen", "query": "SELECT 1",
        })


def test_validate_rejects_malformed_table():
    with pytest.raises(broker.BrokerError, match="table"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl; DROP",
        })


def test_validate_rejects_malformed_account_id_before_any_aws_call():
    # Never even attempts _assumed_session (no AWS/network call from this test).
    with pytest.raises(broker.BrokerError, match="account_id"):
        broker._validate({
            "account_id": "12345", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl",
        })


def test_lambda_handler_shapes_identifier_rejection_as_ok_false():
    result = broker.lambda_handler({
        "action": "query", "account_id": "bad", "region": "ap-northeast-2",
        "workgroup": "wg", "database": "db", "query": "SELECT 1",
    }, None)
    assert result["ok"] is False
    assert "account_id" in result["reason"]


# ── existing SELECT-only guard (unchanged behavior, sanity-checked here too) ───────────────────

def test_reject_non_select_rejects_mutating_keyword():
    with pytest.raises(broker.BrokerError):
        broker._reject_non_select("SELECT 1; DROP TABLE x")


def test_reject_non_select_accepts_bare_select():
    broker._reject_non_select("SELECT 1")  # must not raise
