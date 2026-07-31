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

    def test_replace_scalar_function_no_longer_a_false_positive(self):
        # PR-review MAJOR: bare \bREPLACE\b false-flagged the read-only scalar string function.
        self._ok("SELECT replace(col, 'a', 'b') FROM t")

    def test_replace_into_and_replace_table_still_rejected(self):
        self._bad("REPLACE INTO t VALUES (1)")
        self._bad("REPLACE TABLE t (a int)")

    def test_update_explicitly_rejected(self):
        self._bad("UPDATE t SET x = 1")

    def test_explain_select_allowed_explain_analyze_of_mutation_still_blocked(self):
        # PR-review MINOR: EXPLAIN is a legitimate Aurora diagnostic first-token; the mutating
        # statement it explains is still caught by DANGER regardless of the first-token check.
        self._ok("EXPLAIN SELECT * FROM t")
        self._bad("EXPLAIN DELETE FROM t")

    def test_mysql_executable_comment_fails_closed_for_any_caller(self):
        # PR-review MAJOR: /*! ... */ is executed by MySQL/Aurora-MySQL, not a real comment.
        self._bad("SELECT 1 /*!50000 INTO OUTFILE '/tmp/x'*/")


class TestPostgresDialect(unittest.TestCase):
    """aws_rds_mcp.py's RDS/PostgreSQL call path passes hash_comment=False, backslash_escapes=False
    (Aurora PostgreSQL: no '#' line comments — '#'/'#>'/'#>>' are jsonb operators — and
    standard_conforming_strings=on by default, so '\\' is a literal char, not an escape)."""

    def _ok(self, sql):
        g.assert_read_only(sql, hash_comment=False, backslash_escapes=False)  # no raise

    def _bad(self, sql):
        with self.assertRaises(ValueError, msg=sql):
            g.assert_read_only(sql, hash_comment=False, backslash_escapes=False)

    def test_jsonb_hash_operator_not_treated_as_comment(self):
        # PR-review CRITICAL: '#' stripped as a comment hid the trailing "INTO write_probe" CTAS.
        self._bad("SELECT '{\"a\":1}'::jsonb #> '{a}' INTO write_probe")

    def test_select_into_ctas_rejected(self):
        # PR-review CRITICAL: Postgres SELECT ... INTO table is CTAS (a real write), not a plain read.
        self._bad("SELECT * INTO write_probe FROM t")

    def test_select_into_outfile_rejected(self):
        self._bad("SELECT * FROM t INTO OUTFILE '/tmp/x'")

    def test_dangerous_pg_functions_rejected(self):
        for fn in ["pg_read_file('/etc/passwd')", "pg_ls_dir('/etc')", "lo_import('/etc/passwd')",
                   "lo_export(1, '/tmp/x')", "lo_create(1)", "lo_unlink(1)",
                   "dblink('host=x', 'select 1')", "pg_terminate_backend(123)"]:
            self._bad(f"SELECT {fn}")

    def test_backslash_terminated_string_hiding_second_statement_rejected(self):
        # PR-review MAJOR: with standard_conforming_strings=on, 'a\' ends the string at the next ',
        # not after the backslash — treating '\' as an escape here mis-scanned past a real DELETE.
        self._bad("SELECT 'a\\' ; DELETE FROM t; SELECT 'b'")

    def test_plain_select_still_allowed(self):
        self._ok("SELECT * FROM t WHERE x = 1")

    def test_replace_scalar_function_still_allowed(self):
        self._ok("SELECT replace(col, 'a', 'b') FROM t")


if __name__ == "__main__":
    unittest.main()
