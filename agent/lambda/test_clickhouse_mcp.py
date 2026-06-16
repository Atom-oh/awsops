"""Tests for clickhouse_mcp — read-only SQL guard (incl. table-function SSRF block) + query tools."""
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import clickhouse_mcp as ch  # noqa: E402

DS = {"endpoint": "http://ch:8123", "username": "default", "password": "pw"}


class TestReadOnlyGuard(unittest.TestCase):
    def _ok(self, sql):
        ch._assert_read_only(sql)  # no raise

    def _bad(self, sql):
        with self.assertRaises(ValueError, msg=sql):
            ch._assert_read_only(sql)

    def test_accept(self):
        for s in ["SELECT 1", "  select * from t", "WITH x AS (SELECT 1) SELECT * FROM x",
                  "SHOW TABLES", "DESCRIBE TABLE t", "DESC t", "EXISTS TABLE t",
                  "SELECT/**/ 1", "SELECT 1 /* trailing */"]:  # comments between tokens are fine
            self._ok(s)

    def test_reject_dml_ddl(self):
        for s in ["INSERT INTO t VALUES (1)", "DROP TABLE t", "ALTER TABLE t ADD c Int",
                  "CREATE TABLE t (a Int)", "DELETE FROM t", "TRUNCATE TABLE t",
                  "OPTIMIZE TABLE t", "GRANT SELECT ON db.* TO u", "KILL QUERY WHERE 1",
                  "RENAME TABLE a TO b", "SYSTEM RELOAD", "SET max_threads=1"]:
            self._bad(s)

    def test_reject_stacked(self):
        self._bad("SELECT 1; DROP TABLE t")
        self._bad("SELECT/**/1 ;  INSERT INTO t VALUES (1)")

    def test_reject_comment_hidden_verb(self):
        self._bad("INS/**/ERT INTO t VALUES (1)")  # strip → INSERT
        self._bad("SELECT 1 -- harmless\n; DROP TABLE t")

    def test_reject_table_functions(self):
        for s in ["SELECT * FROM url('http://169.254.169.254/latest/meta-data/')",
                  "SELECT/**/* FROM mysql('h:3306','db','t','u','p')",
                  "SELECT * FROM s3('https://x/y','CSV')",
                  "SELECT * FROM remote('1.2.3.4','db.t')",
                  "select * from postgresql('h','db','t','u','p')",
                  "SELECT * FROM file('/etc/passwd')"]:
            self._bad(s)

    def test_reject_table_function_siblings_and_obfuscation(self):
        # P4 gate: urlCluster/s3Cluster/remoteSecure/executable/redis siblings + backtick evasion
        for s in ["SELECT * FROM urlCluster('c','http://169.254.169.254/','CSV','x String')",
                  "SELECT * FROM s3Cluster('c','https://x/y','CSV')",
                  "SELECT * FROM remoteSecure('h','db.t')",
                  "SELECT * FROM executable('script.sh','CSV','x String')",
                  "SELECT * FROM redis('h:6379','k','x String')",
                  "SELECT * FROM `url`('http://169.254.169.254/')",
                  "SELECT * FROM url/**/('http://169.254.169.254/')"]:
            self._bad(s)

    def test_string_literal_not_false_trigger(self):
        # 'set'/'drop' inside a string literal must not trigger (literals are stripped before scan)
        self._ok("SELECT 'please set the drop value' AS note")


class TestTools(unittest.TestCase):
    def setUp(self):
        self._ld = mock.patch.object(ch, "load_datasource", return_value=DS); self._ld.start(); self.addCleanup(self._ld.stop)
        self._ah = mock.patch.object(ch, "assert_host_allowed", return_value=None); self._ah.start(); self.addCleanup(self._ah.stop)

    def test_query_builds_request(self):
        captured = {}

        def fake_http(method, url, headers=None, body=None, timeout=None):
            captured.update(method=method, url=url, headers=headers, body=body)
            return 200, {"data": [{"x": 1}, {"x": 2}, {"x": 3}], "rows": 3}

        with mock.patch.object(ch, "http_json", side_effect=fake_http):
            out = ch.lambda_handler({"tool_name": "clickhouse_query",
                                     "arguments": {"sql": "SELECT x FROM t", "max_rows": 2}}, None)
        self.assertEqual(out["statusCode"], 200)
        body = json.loads(out["body"])
        self.assertEqual(body["rowCount"], 2)  # truncated to max_rows=2
        self.assertEqual(captured["method"], "POST")
        self.assertIn("readonly=1", captured["url"])
        self.assertIn("max_result_rows=2", captured["url"])
        self.assertIn("FORMAT JSON", captured["body"])
        self.assertEqual(captured["headers"]["Authorization"][:6], "Basic ")

    def test_query_rejects_non_readonly_before_request(self):
        with mock.patch.object(ch, "http_json") as hj:
            out = ch.lambda_handler({"tool_name": "clickhouse_query", "arguments": {"sql": "DROP TABLE t"}}, None)
        self.assertEqual(out["statusCode"], 400)
        hj.assert_not_called()  # no request made

    def test_tables_and_describe(self):
        with mock.patch.object(ch, "http_json", return_value=(200, {"data": []})) as hj:
            ch.lambda_handler({"tool_name": "clickhouse_tables", "arguments": {}}, None)
            self.assertIn("SHOW TABLES", hj.call_args.kwargs.get("body") or hj.call_args.args[3])
            ch.lambda_handler({"tool_name": "clickhouse_describe", "arguments": {"table": "t"}}, None)

    def test_not_connected(self):
        with mock.patch.object(ch, "load_datasource", side_effect=ch.NotConnected("clickhouse not connected")):
            out = ch.lambda_handler({"tool_name": "clickhouse_query", "arguments": {"sql": "SELECT 1"}}, None)
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("not connected", json.loads(out["body"])["error"].lower())

    def test_ssrf_blocked(self):
        with mock.patch.object(ch, "assert_host_allowed", side_effect=ch.SsrfBlocked("endpoint blocked: metadata")):
            out = ch.lambda_handler({"tool_name": "clickhouse_query", "arguments": {"sql": "SELECT 1"}}, None)
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("blocked", json.loads(out["body"])["error"].lower())

    def test_http_error_mapped(self):
        with mock.patch.object(ch, "http_json", return_value=(403, {"raw": "Authentication failed"})):
            out = ch.lambda_handler({"tool_name": "clickhouse_query", "arguments": {"sql": "SELECT 1"}}, None)
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("403", json.loads(out["body"])["error"])

    def test_describe_rejects_injection(self):
        with mock.patch.object(ch, "http_json") as hj:
            out = ch.lambda_handler({"tool_name": "clickhouse_describe", "arguments": {"table": "t; DROP TABLE x"}}, None)
        self.assertEqual(out["statusCode"], 400)
        hj.assert_not_called()

    def test_target_account_id_popped(self):
        with mock.patch.object(ch, "http_json", return_value=(200, {"data": []})):
            out = ch.lambda_handler({"tool_name": "clickhouse_query",
                                     "arguments": {"sql": "SELECT 1", "target_account_id": "222222222222"}}, None)
        self.assertEqual(out["statusCode"], 200)


if __name__ == "__main__":
    unittest.main()
