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
        self.rds_data_client = mock.MagicMock()
        self.rds_data_client.execute_statement.return_value = {"columnMetadata": [], "records": []}

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
        status, body = self._status("SELECT id, requested_by FROM diagnosis_reports LIMIT 10")
        self.assertEqual(status, 200)
        self.rds_data_client.execute_statement.assert_called_once()

    def test_benign_select_with_a_decoy_comment_still_passes(self):
        # The pentest's own repro used SELECT/*delete*/table_name FROM information_schema.tables to
        # PROVE the old filter's block-comment bypass — the query itself is a plain read (the "delete"
        # is a decoy word inside a comment, not a real DML verb) and must still succeed.
        status, _ = self._status("SELECT/*delete*/table_name FROM/**/information_schema.tables")
        self.assertEqual(status, 200)
        self.rds_data_client.execute_statement.assert_called_once()

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


if __name__ == "__main__":
    unittest.main()
