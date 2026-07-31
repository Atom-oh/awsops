"""Tests for aws_rds_mcp's execute_sql read-only guard.

pentest-remediation P2-4: the old guard was `kw in sql.lower().split()` — whitespace-only
tokenization. These reproduce the pentest's exact bypass payloads and confirm the shared
sql_readonly_guard now rejects them (and still allows real SELECTs through).
"""
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import aws_rds_mcp as rds_mcp  # noqa: E402


def _event(sql, resource_arn="arn:aws:rds:ap-northeast-2:123456789012:cluster:c1", secret_arn="arn:aws:secretsmanager:x", database="postgres"):
    return {
        "tool_name": "execute_sql",
        "arguments": {
            "sql": sql,
            "resource_arn": resource_arn,
            "secret_arn": secret_arn,
            "database": database,
        },
    }


class TestExecuteSqlGuard(unittest.TestCase):
    def setUp(self):
        self.rds_client = mock.MagicMock()
        # These tests exercise the Postgres dialect path (the tool's historical hardcoded flags,
        # now resolved dynamically per PR-review round-2 CRITICAL #2) — default the cluster lookup
        # to aurora-postgresql. MySQL-dialect behavior has its own test class below.
        self.rds_client.describe_db_clusters.return_value = {"DBClusters": [{"Engine": "aurora-postgresql"}]}
        self.rds_data_client = mock.MagicMock()
        self.rds_data_client.execute_statement.return_value = {"columnMetadata": [], "records": []}
        self.rds_data_client.begin_transaction.return_value = {"transactionId": "txn-1"}

        def fake_get_client(service, region, role_arn):
            return self.rds_data_client if service == "rds-data" else self.rds_client

        self.get_client_patch = mock.patch.object(rds_mcp, "get_client", side_effect=fake_get_client)
        self.get_client_patch.start()

    def tearDown(self):
        self.get_client_patch.stop()

    def _status(self, sql):
        resp = rds_mcp.lambda_handler(_event(sql), None)
        return resp["statusCode"], json.loads(resp["body"])

    def test_plain_select_reaches_the_data_api(self):
        # PR-review round 3: execute_sql now wraps the query in a DB-level READ ONLY transaction —
        # begin_transaction, then TWO execute_statement calls (SET TRANSACTION READ ONLY, then the
        # real query) both carrying the SAME transactionId, then rollback_transaction in `finally`.
        status, body = self._status("SELECT id, requested_by FROM diagnosis_reports LIMIT 10")
        self.assertEqual(status, 200)
        self.rds_data_client.begin_transaction.assert_called_once()
        calls = self.rds_data_client.execute_statement.call_args_list
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0].kwargs["sql"], "SET TRANSACTION READ ONLY")
        self.assertEqual(calls[1].kwargs["sql"], "SELECT id, requested_by FROM diagnosis_reports LIMIT 10")
        self.assertEqual(calls[0].kwargs["transactionId"], "txn-1")
        self.assertEqual(calls[1].kwargs["transactionId"], "txn-1")
        self.rds_data_client.rollback_transaction.assert_called_once_with(
            resourceArn="arn:aws:rds:ap-northeast-2:123456789012:cluster:c1",
            secretArn="arn:aws:secretsmanager:x", transactionId="txn-1")
        self.rds_data_client.commit_transaction.assert_not_called()

    def test_benign_select_with_a_decoy_comment_still_passes(self):
        # The pentest's own repro used SELECT/*delete*/table_name FROM information_schema.tables to
        # PROVE the old filter's block-comment bypass — the query itself is a plain read (the "delete"
        # is a decoy word inside a comment, not a real DML verb) and must still succeed.
        status, _ = self._status("SELECT/*delete*/table_name FROM/**/information_schema.tables")
        self.assertEqual(status, 200)
        self.assertEqual(self.rds_data_client.execute_statement.call_count, 2)

    def test_the_exact_pentest_bypass_is_now_blocked(self):
        # These chain the same block-comment technique onto REAL write verbs — the pentest report's
        # follow-on steps once the decoy above proved the filter was bypassable. The old
        # `kw in sql.lower().split()` check tokenized on whitespace only, so a keyword glued to a
        # comment never produced the bare token "insert"/"update" and sailed through.
        for sql in [
            "INSERT/*delete*/INTO/**/diagnosis_subscribers(email) VALUES('pentester@test.com')",
            "UPDATE/*delete*/accounts SET alias='pwned' WHERE account_id=1",
        ]:
            status, body = self._status(sql)
            self.assertEqual(status, 400, msg=sql)
            self.assertIn("read-only", body["error"])
        self.rds_data_client.execute_statement.assert_not_called()

    def test_rejects_keywords_the_old_filter_never_covered(self):
        for sql in ["GRANT SELECT ON t TO u", "SET search_path = evil", "CALL do_something()", "COPY t TO '/tmp/x'"]:
            status, _ = self._status(sql)
            self.assertEqual(status, 400, msg=sql)
        self.rds_data_client.execute_statement.assert_not_called()

    def test_rejects_stacked_statements(self):
        status, _ = self._status("SELECT 1; DROP TABLE t")
        self.assertEqual(status, 400)
        self.rds_data_client.execute_statement.assert_not_called()


class TestExecuteSqlEngineDialect(unittest.TestCase):
    """PR-review round-2 CRITICAL #2: execute_sql is registered for both engines but was always
    forcing Postgres guard flags — on a real MySQL target (which DOES backslash-escape) that
    mis-scans a string and hides a mutating construct past the closing quote."""

    def setUp(self):
        self.rds_client = mock.MagicMock()
        self.rds_data_client = mock.MagicMock()
        self.rds_data_client.execute_statement.return_value = {"columnMetadata": [], "records": []}
        self.rds_data_client.begin_transaction.return_value = {"transactionId": "txn-1"}

        def fake_get_client(service, region, role_arn):
            return self.rds_data_client if service == "rds-data" else self.rds_client

        self.get_client_patch = mock.patch.object(rds_mcp, "get_client", side_effect=fake_get_client)
        self.get_client_patch.start()

    def tearDown(self):
        self.get_client_patch.stop()

    def _status(self, sql):
        resp = rds_mcp.lambda_handler(_event(sql), None)
        return resp["statusCode"], json.loads(resp["body"])

    def test_mysql_backslash_hidden_into_outfile_now_rejected(self):
        # Forcing Postgres flags (backslash_escapes=False) on a MySQL target mis-scans this: the
        # guard thinks the string ends right after `x\`, hiding "y' INTO OUTFILE ..." from DANGER.
        self.rds_client.describe_db_clusters.return_value = {"DBClusters": [{"Engine": "aurora-mysql"}]}
        status, body = self._status("SELECT 'x\\' y' INTO OUTFILE '/tmp/x'")
        self.assertEqual(status, 400)
        self.assertIn("read-only", body["error"])
        self.rds_data_client.execute_statement.assert_not_called()
        self.rds_data_client.begin_transaction.assert_not_called()

    def test_mysql_dash_dash_comment_bypass_now_rejected(self):
        # PR-review round 3: MySQL only treats `--` as a comment when followed by whitespace/a
        # control char (or EOF). `--1` is not a comment in MySQL — it parses as `1 - -1` — so the
        # old dialect-unaware strip_sql hid `INTO OUTFILE` behind a fake comment here.
        self.rds_client.describe_db_clusters.return_value = {"DBClusters": [{"Engine": "aurora-mysql"}]}
        status, body = self._status("SELECT 1--1 INTO OUTFILE '/tmp/x'")
        self.assertEqual(status, 400)
        self.assertIn("read-only", body["error"])
        self.rds_data_client.execute_statement.assert_not_called()

    def test_mysql_dollar_quote_hidden_into_outfile_now_rejected(self):
        # PR-review round 5 MAJOR: `$tag$` dollar-quoting is Postgres-only syntax. MySQL parses `$`
        # as an ordinary identifier char, so `$x$` here is just a weird alias, NOT a heredoc — but
        # the old dialect-agnostic scanner treated it as an unterminated dollar-quoted string and
        # swallowed the real `INTO OUTFILE` past it.
        self.rds_client.describe_db_clusters.return_value = {"DBClusters": [{"Engine": "aurora-mysql"}]}
        status, body = self._status("SELECT 1 AS $x$ INTO OUTFILE '/tmp/x'")
        self.assertEqual(status, 400)
        self.assertIn("read-only", body["error"])
        self.rds_data_client.execute_statement.assert_not_called()

    def test_mysql_plain_select_still_allowed(self):
        # Round-4 fix: MySQL does NOT get the begin_transaction/"SET TRANSACTION READ ONLY"/rollback
        # wrapper — `SET TRANSACTION READ ONLY` is invalid mid-transaction on MySQL (error 1568) and
        # round 3's version of this test only proved a MagicMock doesn't enforce real MySQL syntax,
        # silently masking that every real MySQL query would have failed. MySQL read-only enforcement
        # is lexical-guard-only (see TestExecuteSqlEngineDialect above); this test proves the query
        # actually reaches the Data API as a single plain execute_statement, no transaction calls.
        self.rds_client.describe_db_clusters.return_value = {"DBClusters": [{"Engine": "aurora-mysql"}]}
        status, _ = self._status("SELECT * FROM t WHERE x = 1")
        self.assertEqual(status, 200)
        self.rds_data_client.begin_transaction.assert_not_called()
        self.rds_data_client.rollback_transaction.assert_not_called()
        self.rds_data_client.execute_statement.assert_called_once_with(
            sql="SELECT * FROM t WHERE x = 1",
            resourceArn="arn:aws:rds:ap-northeast-2:123456789012:cluster:c1",
            secretArn="arn:aws:secretsmanager:x", database="postgres")

    def test_unresolvable_engine_fails_closed_rather_than_guessing(self):
        self.rds_client.describe_db_clusters.side_effect = Exception("boom")
        status, body = self._status("SELECT 1")
        self.assertEqual(status, 400)
        self.assertIn("read-only", body["error"])
        self.rds_data_client.execute_statement.assert_not_called()
        self.rds_data_client.begin_transaction.assert_not_called()

    def test_unrecognized_engine_string_fails_closed(self):
        self.rds_client.describe_db_clusters.return_value = {"DBClusters": [{"Engine": "some-future-engine"}]}
        status, body = self._status("SELECT 1")
        self.assertEqual(status, 400)
        self.rds_data_client.execute_statement.assert_not_called()
        self.rds_data_client.begin_transaction.assert_not_called()


class TestExecuteSqlReadOnlyTransaction(unittest.TestCase):
    """PR-review round 3 CRITICAL: a lexical denylist can't practically enumerate every present/
    future write-capable string function on Postgres/MySQL (query_to_xml(...RETURNING...), lo_put,
    set_config, ...) given this tool runs with the app's own Aurora MASTER credentials. These prove
    the structural fix — every execute_sql call runs inside a DB-level READ ONLY transaction — via
    the call sequence (begin -> SET TRANSACTION READ ONLY -> user SQL -> rollback), since a plain
    mock can't itself enforce Postgres/MySQL transaction semantics."""

    def setUp(self):
        self.rds_client = mock.MagicMock()
        self.rds_client.describe_db_clusters.return_value = {"DBClusters": [{"Engine": "aurora-postgresql"}]}
        self.rds_data_client = mock.MagicMock()
        self.rds_data_client.begin_transaction.return_value = {"transactionId": "txn-1"}

        def fake_get_client(service, region, role_arn):
            return self.rds_data_client if service == "rds-data" else self.rds_client

        self.get_client_patch = mock.patch.object(rds_mcp, "get_client", side_effect=fake_get_client)
        self.get_client_patch.start()

    def tearDown(self):
        self.get_client_patch.stop()

    def _status(self, sql):
        resp = rds_mcp.lambda_handler(_event(sql), None)
        return resp["statusCode"], json.loads(resp["body"])

    def test_set_config_is_rejected_lexically_not_by_the_transaction(self):
        # Round-3's version of this test simulated the engine rejecting `set_config(...)` inside a
        # READ ONLY transaction (READ_ONLY_SQL_TRANSACTION) — that's not real Postgres behavior:
        # GUC/session-variable changes are explicitly PERMITTED inside a read-only transaction (they
        # aren't "writes" from the engine's point of view), so that test encoded a false guarantee.
        # Round-4 fix: `set_config` is now in sql_readonly_guard's DANGER pattern, so this is caught
        # at the assert_read_only layer, before the Data API (or any transaction) is ever touched.
        status, body = self._status("SELECT set_config('search_path', 'public', false)")
        self.assertEqual(status, 400)
        self.assertIn("read-only", body["error"])
        self.rds_data_client.begin_transaction.assert_not_called()
        self.rds_data_client.execute_statement.assert_not_called()
        self.rds_data_client.rollback_transaction.assert_not_called()

    def test_normal_select_works_end_to_end_through_the_transaction_wrapped_flow(self):
        self.rds_data_client.execute_statement.return_value = {"columnMetadata": [], "records": []}
        status, body = self._status("SELECT 1")
        self.assertEqual(status, 200)
        calls = self.rds_data_client.execute_statement.call_args_list
        self.assertEqual([c.kwargs["transactionId"] for c in calls], ["txn-1", "txn-1"])
        self.rds_data_client.rollback_transaction.assert_called_once()
        self.rds_data_client.commit_transaction.assert_not_called()

    def test_set_transaction_read_only_failure_aborts_without_running_the_query(self):
        def fake_execute_statement(transactionId, sql, **kwargs):
            if sql == "SET TRANSACTION READ ONLY":
                raise Exception("boom")
            raise AssertionError("must not execute the user SQL if READ ONLY setup failed")

        self.rds_data_client.execute_statement.side_effect = fake_execute_statement
        status, body = self._status("SELECT 1")
        self.assertEqual(status, 400)
        self.assertIn("read-only", body["error"])
        self.assertEqual(self.rds_data_client.execute_statement.call_count, 1)
        self.rds_data_client.rollback_transaction.assert_called_once_with(
            resourceArn="arn:aws:rds:ap-northeast-2:123456789012:cluster:c1",
            secretArn="arn:aws:secretsmanager:x", transactionId="txn-1")


if __name__ == "__main__":
    unittest.main()
