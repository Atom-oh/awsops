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

PR-review round-3 finding: `--` was treated as an unconditional line-comment start for every
dialect. PostgreSQL agrees, but MySQL only treats `--` as a comment when the second dash is
followed by whitespace/a control character (or end of input) — `--1`, `--(`, etc. are NOT comments
in MySQL, they parse as ordinary tokens (e.g. `1--1` is `1 - -1`). Unconditionally stripping `--1`
as a comment on the MySQL path hid a trailing `INTO OUTFILE` behind a fake comment
(`SELECT 1--1 INTO OUTFILE '/tmp/x'`). `dash_comment_needs_boundary=True` (set on the RDS MySQL
path) requires that trailing boundary before `--` is treated as a comment; PostgreSQL/ClickHouse
keep the old unconditional behavior (`dash_comment_needs_boundary=False`, the default).

PR-review round-4 findings (both classes the DB-level READ ONLY transaction backstop in
aws_rds_mcp.py genuinely cannot catch, because PostgreSQL's read-only transaction mode only blocks
actual data writes — control-plane and session-GUC calls sail through it):
- `pg_cancel_backend` (and read-only-transaction-immune info-disclosure functions
  `pg_read_binary_file`, `pg_stat_file`, `pg_ls_\w+` covering `pg_ls_dir`/`pg_ls_waldir`/etc., MySQL's
  `load_file(...)`) are ordinary read-verb-first function calls that a READ ONLY transaction does
  NOT reject — they had to be added here, lexically, since the transaction backstop is not a
  backstop for this class at all.
- `set_config(...)` looked, in round 3, like something the engine's read-only transaction mode
  would reject (same logic as an UPDATE) — it does not: GUC/session-variable changes are explicitly
  allowed inside a Postgres READ ONLY transaction. `pg_advisory_\w+` (advisory locks) and `lo_put`
  (large-object write, missed alongside the round-2 `lo_import`/`lo_export`/`lo_create`/`lo_unlink`
  set) are the same story. All three are lexical-guard-only catches; see the corrected test in
  test_aws_rds_mcp.py that used to (incorrectly) assert the transaction caught `set_config`.

PR-review round-5 CRITICAL: PostgreSQL block comments NEST by spec — `/* outer /* inner */ still-
comment */` is ONE comment ending at the outermost `*/`, not two. The old scanner did a single
`sql.find("*/", ...)` from the first `/*`, so it stopped at the FIRST `*/` (inside the nested
comment) and treated everything after that (a stray `'` from the payload, then real SQL) as if it
were outside the comment — the stray `'` then ate the rest of the string as an "unterminated
literal", hiding a real `pg_cancel_backend(...)` call from DANGER *and* from the DB-level READ ONLY
backstop (control-plane calls aren't writes). Fixed with a real depth-tracking scanner below.
MySQL doesn't nest block comments, but defaulting to "nested" is the safe direction here (it only
ever consumes MORE as comment, never less) — there's no dialect flag for this.
Defense-in-depth: after stripping, if a literal `/*` or `*/` remains in the output, the comment
scanner didn't cleanly resolve — fail closed rather than pass through a partially-stripped string.

PR-review round-5 MAJOR: dollar-quoting (`$tag$...$tag$`) is Postgres-only syntax; MySQL allows `$`
as an ordinary identifier character, so `SELECT 1 AS $x$ INTO OUTFILE ...` on a MySQL target isn't
a heredoc at all — but the old dialect-agnostic scanner saw `$x$`, found no matching close, and
swallowed `INTO OUTFILE` as "still inside the string". `dollar_quote=False` on the MySQL path
disables that scan (Postgres/ClickHouse keep the default `dollar_quote=True`).
"""
import re

READ_VERBS = ("SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXISTS", "EXPLAIN")
# Union of every write/admin/session verb either caller's dialect supports, plus INTO (blocks Postgres
# `SELECT ... INTO table` CTAS and MySQL `SELECT ... INTO OUTFILE/DUMPFILE`, both otherwise
# indistinguishable from a plain SELECT by the first-token check) and known dangerous Postgres
# functions (file/large-object access, dblink SSRF, backend termination, sequence mutation via
# setval/nextval) that are just ordinary function calls inside a syntactically-valid SELECT.
# Blocking a verb/fn the target engine doesn't have is harmless (it can never appear in a
# legitimate read-only query); missing one that it does have is the actual vulnerability class
# this module exists to close. REPLACE is anchored to its mutating statement forms (REPLACE INTO /
# REPLACE TABLE) — a bare `\bREPLACE\b` also matches the read-only scalar string function
# `replace(col, 'a', 'b')`, which is common and harmless. `dblink\w*` (not `\bdblink\b`) so
# `dblink_exec(...)` also trips — underscore is a word char, so `\b` alone doesn't end at `dblink`.
DANGER = re.compile(
    r"\b(INSERT|ALTER|DROP|CREATE|DELETE|TRUNCATE|OPTIMIZE|ATTACH|DETACH|SET|SYSTEM|GRANT|REVOKE|"
    r"KILL|MOVE|RENAME|CALL|COPY|MERGE|REPLACE\s+(?:INTO|TABLE)|LOCK|EXECUTE|DO|VACUUM|REINDEX|LISTEN|"
    r"NOTIFY|REFRESH|UPDATE|INTO|"
    r"pg_read_file|pg_read_binary_file|pg_stat_file|pg_ls_\w+|lo_import|lo_export|lo_create|lo_unlink|"
    r"lo_put|dblink\w*|pg_terminate_backend|pg_cancel_backend|pg_advisory_\w+|set_config|load_file|"
    r"setval|nextval)\b",
    re.IGNORECASE,
)


def strip_sql(sql, hash_comment=True, backslash_escapes=True, dash_comment_needs_boundary=False,
              dollar_quote=True):
    """Single left-to-right tokenizer (NOT sequential regexes — those desync on a quote inside an
    identifier and can eat a forbidden token, e.g. a ClickHouse url( call, past the guard). Drops
    string literals + comments; for IDENTIFIER quotes (` and ") keeps the inner name but removes the
    quote chars so `drop`(…) / "drop"(…) still hit DANGER. Each context is consumed by its own
    closing rule, so a ' inside `…`/"…" or a --/;/* inside a '…' can never cross-contaminate.

    hash_comment: whether `#` starts a line comment (True for MySQL/ClickHouse; False for PostgreSQL,
    where `#`/`#>`/`#>>` are jsonb operators, not comments).
    backslash_escapes: whether `\\` inside a '...' string escapes the next char (True for MySQL's
    default; False for PostgreSQL's default `standard_conforming_strings=on`, where `\\` is literal).
    dash_comment_needs_boundary: whether `--` requires a following whitespace/control char (or EOF)
    to count as a comment (True for MySQL, which parses e.g. `--1` as subtraction, not a comment;
    False for PostgreSQL/ClickHouse, where `--` is unconditionally a line comment).
    dollar_quote: whether `$tag$...$tag$` is a heredoc/dollar-quoted string (True for Postgres/
    ClickHouse; False for MySQL, where `$` is an ordinary identifier character and there's no such
    syntax — scanning for it there lets a bogus `$x$`-looking alias hide real SQL past it).
    """
    out = []
    n = len(sql)
    idx = 0
    while idx < n:
        c = sql[idx]
        two = sql[idx:idx + 2]
        if two == "/*":                       # block comment — PostgreSQL/SQL-standard NESTING
            if sql[idx:idx + 3] == "/*!":     # MySQL executable comment — NOT a real comment, fail closed
                raise ValueError("read-only: MySQL executable comment (/*! ... */) is not allowed")
            # PR-review round-5 CRITICAL: `/* outer /* inner */ still-comment */` is ONE comment in
            # real Postgres, ending at the OUTERMOST `*/` — a single find("*/") stops at the first
            # (inner) close and leaves the rest of the payload looking like live SQL. Track nesting
            # depth instead. Defaulting to "nested" even for dialects that don't nest (MySQL) is the
            # safe direction: it only ever swallows more as comment, never exposes less.
            depth = 1
            idx += 2
            while idx < n and depth > 0:
                if sql[idx:idx + 2] == "/*":
                    depth += 1
                    idx += 2
                elif sql[idx:idx + 2] == "*/":
                    depth -= 1
                    idx += 2
                else:
                    idx += 1
            out.append(" ")
        elif (two == "--" and (
                not dash_comment_needs_boundary
                or idx + 2 >= n
                or sql[idx + 2].isspace()
                or ord(sql[idx + 2]) < 0x20
              )) or (hash_comment and c == "#"):  # line comment (-- and MySQL/ClickHouse #)
            j = sql.find("\n", idx)
            idx = j if j != -1 else n
            out.append(" ")
        elif c == "'":                        # STRING literal → drop contents
            # Postgres E'...'/U&'...' literals ALWAYS backslash-escape, regardless of
            # standard_conforming_strings (that's what the E/U& prefix means) — so this literal
            # scans in escaped mode even if the caller passed backslash_escapes=False for
            # ordinary '...' literals on that dialect. Word-boundary-guarded so an identifier
            # char right before E/U& (part of a longer name) can't false-trigger it.
            literal_escapes = backslash_escapes or bool(
                re.search(r"(?<![A-Za-z0-9_])[Ee]$", sql[:idx])
                or re.search(r"(?<![A-Za-z0-9_])[Uu]&$", sql[:idx])
            )
            idx += 1
            while idx < n:
                if literal_escapes and sql[idx] == "\\":
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
        elif dollar_quote and c == "$" and re.match(r"\$[A-Za-z0-9_]*\$", sql[idx:]):  # heredoc/dollar-quoted string
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
    result = "".join(out)
    # PR-review round-5 defense-in-depth: a literal `/*` or `*/` surviving to here means the comment
    # scanner didn't cleanly resolve (e.g. some future edge case leaves nesting depth unbalanced) —
    # fail closed instead of passing through whatever partial strip result was produced.
    if "/*" in result or "*/" in result:
        raise ValueError("read-only: unresolved block comment marker after parsing")
    return result


def assert_read_only(sql, read_verbs=READ_VERBS, danger_re=DANGER, extra_forbidden_re=None,
                      extra_message=None, hash_comment=True, backslash_escapes=True,
                      dash_comment_needs_boundary=False, dollar_quote=True):
    """Raise ValueError unless `sql` is a single, comment/string-stripped statement starting with a
    read verb and containing no DANGER (or caller-supplied extra_forbidden_re) keyword/construct.
    See `strip_sql` for the `hash_comment` / `backslash_escapes` / `dash_comment_needs_boundary` /
    `dollar_quote` dialect knobs."""
    stripped = strip_sql(sql or "", hash_comment=hash_comment, backslash_escapes=backslash_escapes,
                          dash_comment_needs_boundary=dash_comment_needs_boundary,
                          dollar_quote=dollar_quote)
    if len([p for p in stripped.split(";") if p.strip()]) > 1:
        raise ValueError("read-only: multiple statements are not allowed")
    tokens = stripped.strip().split()
    if not tokens or tokens[0].upper() not in read_verbs:
        raise ValueError(f"read-only: only {'/'.join(read_verbs)} queries are allowed")
    if danger_re.search(stripped):
        raise ValueError("read-only: statement contains a disallowed (write/admin) keyword")
    if extra_forbidden_re is not None and extra_forbidden_re.search(stripped):
        raise ValueError(extra_message or "read-only: statement contains a disallowed construct")
