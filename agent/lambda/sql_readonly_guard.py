"""
sql_readonly_guard.py — shared read-only SQL guard.

pentest-remediation P2-4: `aws_rds_mcp.py`'s execute_sql keyword filter used `sql.lower().split()` —
whitespace-only tokenization, so any keyword not surrounded by spaces survived (e.g.
`DROP/*x*/TABLE t` never produces the token "drop"). It also missed GRANT/REVOKE/SET/CALL/COPY/
MERGE/REPLACE/LOCK, required no first-token read-verb, and had no stacked-statement check — none of
which `clickhouse_mcp.py`'s guard has, because that one strips comments/strings BEFORE matching and
requires the first token to be a read verb. Extracted here so both Lambdas share one guard instead of
each hand-rolling (and, for RDS, under-rolling) their own.

Dialect-agnostic on purpose: /* */, --, # line comments, '...' string literals (with \\ and ''
escapes), $tag$ dollar-quoted strings, and `...`/"..." quoted identifiers are shared syntax across
ClickHouse, PostgreSQL, and MySQL (the three engines these two Lambdas talk to via RDS Data API /
ClickHouse HTTP). A caller with dialect-specific forbidden constructs (e.g. ClickHouse's SSRF-capable
table functions) layers its own regex on top via `extra_forbidden_re`.
"""
import re

READ_VERBS = ("SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXISTS")
# Union of every write/admin/session verb either caller's dialect supports. Blocking a verb the
# target engine doesn't have is harmless (it can never appear in a legitimate read-only query);
# missing one that it does have is the actual vulnerability class this module exists to close.
DANGER = re.compile(
    r"\b(INSERT|ALTER|DROP|CREATE|DELETE|TRUNCATE|OPTIMIZE|ATTACH|DETACH|SET|SYSTEM|GRANT|REVOKE|"
    r"KILL|MOVE|RENAME|CALL|COPY|MERGE|REPLACE|LOCK|EXECUTE|DO|VACUUM|REINDEX|LISTEN|NOTIFY|REFRESH)\b",
    re.IGNORECASE,
)


def strip_sql(sql):
    """Single left-to-right tokenizer (NOT sequential regexes — those desync on a quote inside an
    identifier and can eat a forbidden token, e.g. a ClickHouse url( call, past the guard). Drops
    string literals + comments; for IDENTIFIER quotes (` and ") keeps the inner name but removes the
    quote chars so `drop`(…) / "drop"(…) still hit DANGER. Each context is consumed by its own
    closing rule, so a ' inside `…`/"…" or a --/;/* inside a '…' can never cross-contaminate."""
    out = []
    n = len(sql)
    idx = 0
    while idx < n:
        c = sql[idx]
        two = sql[idx:idx + 2]
        if two == "/*":                       # block comment
            j = sql.find("*/", idx + 2)
            idx = (j + 2) if j != -1 else n
            out.append(" ")
        elif two == "--" or c == "#":         # line comment (-- and ClickHouse/MySQL #)
            j = sql.find("\n", idx)
            idx = j if j != -1 else n
            out.append(" ")
        elif c == "'":                        # STRING literal → drop contents
            idx += 1
            while idx < n:
                if sql[idx] == "\\":
                    idx += 2
                    continue
                if sql[idx] == "'":
                    if idx + 1 < n and sql[idx + 1] == "'":  # '' escape
                        idx += 2
                        continue
                    idx += 1
                    break
                idx += 1
            out.append(" ")
        elif c == "$" and re.match(r"\$[A-Za-z0-9_]*\$", sql[idx:]):  # heredoc/dollar-quoted string
            delim = re.match(r"\$[A-Za-z0-9_]*\$", sql[idx:]).group(0)  # $$ or $tag$
            j = sql.find(delim, idx + len(delim))
            idx = (j + len(delim)) if j != -1 else n
            out.append(" ")                   # whole heredoc dropped (a ' inside can't desync)
        elif c == "`" or c == '"':            # IDENTIFIER quote → keep inner, drop quote chars
            q = c
            idx += 1
            while idx < n:
                if sql[idx] == "\\":
                    out.append(sql[idx:idx + 2])
                    idx += 2
                    continue
                if sql[idx] == q:
                    if idx + 1 < n and sql[idx + 1] == q:  # doubled-quote escape inside identifier
                        out.append(sql[idx])
                        idx += 2
                        continue
                    idx += 1
                    break
                out.append(sql[idx])
                idx += 1
        else:
            out.append(c)
            idx += 1
    return "".join(out)


def assert_read_only(sql, read_verbs=READ_VERBS, danger_re=DANGER, extra_forbidden_re=None, extra_message=None):
    """Raise ValueError unless `sql` is a single, comment/string-stripped statement starting with a
    read verb and containing no DANGER (or caller-supplied extra_forbidden_re) keyword/construct."""
    stripped = strip_sql(sql or "")
    if len([p for p in stripped.split(";") if p.strip()]) > 1:
        raise ValueError("read-only: multiple statements are not allowed")
    tokens = stripped.strip().split()
    if not tokens or tokens[0].upper() not in read_verbs:
        raise ValueError(f"read-only: only {'/'.join(read_verbs)} queries are allowed")
    if danger_re.search(stripped):
        raise ValueError("read-only: statement contains a disallowed (write/admin) keyword")
    if extra_forbidden_re is not None and extra_forbidden_re.search(stripped):
        raise ValueError(extra_message or "read-only: statement contains a disallowed construct")
