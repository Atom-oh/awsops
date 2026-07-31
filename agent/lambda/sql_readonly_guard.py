"""
sql_readonly_guard.py — shared read-only SQL guard.

pentest-remediation P2-4: `aws_rds_mcp.py`'s execute_sql keyword filter used `sql.lower().split()` —
whitespace-only tokenization, so any keyword not surrounded by spaces survived (e.g.
`DROP/*x*/TABLE t` never produces the token "drop"). It also missed GRANT/REVOKE/SET/CALL/COPY/
MERGE/REPLACE/LOCK, required no first-token read-verb, and had no stacked-statement check — none of
which `clickhouse_mcp.py`'s guard has, because that one strips comments/strings BEFORE matching and
requires the first token to be a read verb. Extracted here so both Lambdas share one guard instead of
each hand-rolling (and, for RDS, under-rolling) their own.

Dialect-agnostic on purpose: /* */, --, '...' string literals, $tag$ dollar-quoted strings, and
`...`/"..." quoted identifiers are shared syntax across ClickHouse, PostgreSQL, and MySQL (the three
engines these two Lambdas talk to via RDS Data API / ClickHouse HTTP). Two bits of comment/escape
syntax are NOT shared and are dialect-gated via `hash_comment` / `backslash_escapes` (see below).
A caller with dialect-specific forbidden constructs (e.g. ClickHouse's SSRF-capable table functions)
layers its own regex on top via `extra_forbidden_re`.

PR-review P2-4 follow-up (this file was CRITICAL-blocked on first pass):
- `#` is a line comment in MySQL/ClickHouse but NOT in PostgreSQL — there it's the jsonb `#>`/`#>>`
  operator. Stripping "everything after #" on the RDS/Postgres path let `... #> '{a}' INTO probe`
  through as a fake plain SELECT while Postgres executed the real CTAS. `hash_comment=False` on that
  path disables the strip; callers whose engine truly has `#` comments keep `hash_comment=True`.
- Postgres defaults to `standard_conforming_strings=on` (the default since PG9.1, definitely on PG17),
  where `\\` is a literal character inside a string, not an escape. Treating it as an escape let a
  crafted `'a\' ; DELETE ...` string "extend" past its real closing quote and hide a second statement.
  `backslash_escapes=False` on the RDS/Postgres path scans the closing quote correctly; MySQL's default
  DOES escape with `\\`, so that dialect keeps `backslash_escapes=True`.
- `/*! ... */` is MySQL's vendor-conditional *executable* comment — the engine runs the contents, it
  is not a real comment. Stripping it like `/* */` hid executed SQL from the guard. No dialect ever
  needs this literal substring in a legitimate read-only query, so `strip_sql` fails closed on it
  unconditionally (raises instead of stripping), for every caller.
"""
import re

READ_VERBS = ("SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXISTS", "EXPLAIN")
# Union of every write/admin/session verb either caller's dialect supports, plus INTO (blocks Postgres
# `SELECT ... INTO table` CTAS and MySQL `SELECT ... INTO OUTFILE/DUMPFILE`, both otherwise
# indistinguishable from a plain SELECT by the first-token check) and known dangerous Postgres
# functions (file/large-object access, dblink SSRF, backend termination) that are just ordinary
# function calls inside a syntactically-valid SELECT. Blocking a verb/fn the target engine doesn't
# have is harmless (it can never appear in a legitimate read-only query); missing one that it does
# have is the actual vulnerability class this module exists to close. REPLACE is anchored to its
# mutating statement forms (REPLACE INTO / REPLACE TABLE) — a bare `\bREPLACE\b` also matches the
# read-only scalar string function `replace(col, 'a', 'b')`, which is common and harmless.
DANGER = re.compile(
    r"\b(INSERT|ALTER|DROP|CREATE|DELETE|TRUNCATE|OPTIMIZE|ATTACH|DETACH|SET|SYSTEM|GRANT|REVOKE|"
    r"KILL|MOVE|RENAME|CALL|COPY|MERGE|REPLACE\s+(?:INTO|TABLE)|LOCK|EXECUTE|DO|VACUUM|REINDEX|LISTEN|"
    r"NOTIFY|REFRESH|UPDATE|INTO|"
    r"pg_read_file|pg_ls_dir|lo_import|lo_export|lo_create|lo_unlink|dblink|pg_terminate_backend)\b",
    re.IGNORECASE,
)


def strip_sql(sql, hash_comment=True, backslash_escapes=True):
    """Single left-to-right tokenizer (NOT sequential regexes — those desync on a quote inside an
    identifier and can eat a forbidden token, e.g. a ClickHouse url( call, past the guard). Drops
    string literals + comments; for IDENTIFIER quotes (` and ") keeps the inner name but removes the
    quote chars so `drop`(…) / "drop"(…) still hit DANGER. Each context is consumed by its own
    closing rule, so a ' inside `…`/"…" or a --/;/* inside a '…' can never cross-contaminate.

    hash_comment: whether `#` starts a line comment (True for MySQL/ClickHouse; False for PostgreSQL,
    where `#`/`#>`/`#>>` are jsonb operators, not comments).
    backslash_escapes: whether `\\` inside a '...' string escapes the next char (True for MySQL's
    default; False for PostgreSQL's default `standard_conforming_strings=on`, where `\\` is literal).
    """
    out = []
    n = len(sql)
    idx = 0
    while idx < n:
        c = sql[idx]
        two = sql[idx:idx + 2]
        if two == "/*":                       # block comment
            if sql[idx:idx + 3] == "/*!":     # MySQL executable comment — NOT a real comment, fail closed
                raise ValueError("read-only: MySQL executable comment (/*! ... */) is not allowed")
            j = sql.find("*/", idx + 2)
            idx = (j + 2) if j != -1 else n
            out.append(" ")
        elif two == "--" or (hash_comment and c == "#"):  # line comment (-- and MySQL/ClickHouse #)
            j = sql.find("\n", idx)
            idx = j if j != -1 else n
            out.append(" ")
        elif c == "'":                        # STRING literal → drop contents
            idx += 1
            while idx < n:
                if backslash_escapes and sql[idx] == "\\":
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


def assert_read_only(sql, read_verbs=READ_VERBS, danger_re=DANGER, extra_forbidden_re=None,
                      extra_message=None, hash_comment=True, backslash_escapes=True):
    """Raise ValueError unless `sql` is a single, comment/string-stripped statement starting with a
    read verb and containing no DANGER (or caller-supplied extra_forbidden_re) keyword/construct.
    See `strip_sql` for the `hash_comment` / `backslash_escapes` dialect knobs."""
    stripped = strip_sql(sql or "", hash_comment=hash_comment, backslash_escapes=backslash_escapes)
    if len([p for p in stripped.split(";") if p.strip()]) > 1:
        raise ValueError("read-only: multiple statements are not allowed")
    tokens = stripped.strip().split()
    if not tokens or tokens[0].upper() not in read_verbs:
        raise ValueError(f"read-only: only {'/'.join(read_verbs)} queries are allowed")
    if danger_re.search(stripped):
        raise ValueError("read-only: statement contains a disallowed (write/admin) keyword")
    if extra_forbidden_re is not None and extra_forbidden_re.search(stripped):
        raise ValueError(extra_message or "read-only: statement contains a disallowed construct")
