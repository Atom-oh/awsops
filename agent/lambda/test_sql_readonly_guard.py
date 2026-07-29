"""Tests for the shared sql_readonly_guard module (extracted from clickhouse_mcp.py, now also used
by aws_rds_mcp.py — pentest-remediation P2-4)."""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import sql_readonly_guard as g  # noqa: E402


class TestAssertReadOnly(unittest.TestCase):
    def _ok(self, sql):
        g.assert_read_only(sql)  # no raise

    def _bad(self, sql):
        with self.assertRaises(ValueError, msg=sql):
            g.assert_read_only(sql)

    def test_accepts_plain_reads(self):
        for s in ["SELECT 1", "  select * from t", "WITH x AS (SELECT 1) SELECT * FROM x",
                  "SHOW TABLES", "DESCRIBE TABLE t", "DESC t", "EXISTS TABLE t"]:
            self._ok(s)

    def test_rejects_the_full_write_admin_verb_set(self):
        # Includes the verbs the pre-extraction aws_rds_mcp.py filter missed entirely:
        # GRANT/REVOKE/SET/CALL/COPY/MERGE/REPLACE/LOCK.
        for s in ["INSERT INTO t VALUES (1)", "DROP TABLE t", "ALTER TABLE t ADD c int",
                  "CREATE TABLE t (a int)", "DELETE FROM t", "TRUNCATE TABLE t",
                  "GRANT SELECT ON t TO u", "REVOKE SELECT ON t FROM u", "SET x = 1",
                  "CALL proc()", "COPY t TO '/tmp/x'", "MERGE INTO t USING s ON 1=1",
                  "LOCK TABLE t"]:
            self._bad(s)

    def test_rejects_stacked_statements(self):
        self._bad("SELECT 1; DROP TABLE t")

    def test_comment_stripping_defeats_the_split_based_bypass(self):
        # This is the exact bypass class the old `kw in sql.lower().split()` filter missed: a keyword
        # glued to a comment never produces the bare token, so a naive split-based check never sees it.
        self._bad("DROP/*x*/TABLE t")
        self._bad("INSERT/**/INTO t VALUES (1)")
        self._bad("UPDATE/*x*/accounts SET a=1")

    def test_string_literal_contents_are_not_false_triggers(self):
        self._ok("SELECT 'please set the drop value' AS note")

    def test_extra_forbidden_re_layers_a_dialect_specific_check(self):
        # Mirrors how clickhouse_mcp.py layers its ClickHouse-only table-function block on top.
        extra = re.compile(r"\bfile\s*\(", re.IGNORECASE)
        with self.assertRaises(ValueError):
            g.assert_read_only("SELECT * FROM file('/etc/passwd')", extra_forbidden_re=extra)
        g.assert_read_only("SELECT 1", extra_forbidden_re=extra)  # unaffected when absent


if __name__ == "__main__":
    unittest.main()
