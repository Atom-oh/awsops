"""
ClickHouse read-only MCP Lambda — query a user-registered ClickHouse datasource (SQL) for incident
triage. First of the v1 datasource family; uses the shared datasource_http helper (credential load,
SSRF host guard, auth, no-redirect HTTP).

READ-ONLY is enforced on TWO layers:
  1. _assert_read_only(sql): strip comments + string literals, reject stacked statements, require a
     read verb (SELECT/WITH/SHOW/DESCRIBE/DESC/EXISTS), reject DML/DDL/admin verbs, and — critically —
     reject ClickHouse TABLE FUNCTIONS (url/file/remote/s3/mysql/postgresql/jdbc/odbc/mongodb/...),
     which are a syntactically-read-only server-side SSRF / cross-datastore exfil vector that
     `readonly=1` does NOT stop.
  2. readonly=1 + max_result_rows on the ClickHouse HTTP request (server-side backstop).
Stdlib + boto3 only.
"""
import json
import re

from datasource_http import (
    NotConnected,
    SsrfBlocked,
    assert_host_allowed,
    auth_headers,
    http_json,
    load_datasource,
)

SLUG = "clickhouse"
DEFAULT_MAX_ROWS = 100
MAX_ROWS_CAP = 1000

_READ_VERBS = ("SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXISTS")
_DANGER = re.compile(
    r"\b(INSERT|ALTER|DROP|CREATE|DELETE|TRUNCATE|OPTIMIZE|ATTACH|DETACH|SET|SYSTEM|GRANT|REVOKE|KILL|MOVE|RENAME)\b",
    re.IGNORECASE,
)
# ClickHouse table functions = server-side SSRF / cross-datastore reads / script exec (readonly=1 does
# NOT block them). Suffix-tolerant `\w*` so siblings like urlCluster/s3Cluster/remoteSecure/executablePool/
# clusterAllReplicas/hdfsCluster are ALSO blocked (a name-anchored `\s*\(` would let urlCluster( through).
_TABLE_FN = re.compile(
    r"\b(url|file|remote|hdfs|s3|gcs|iceberg|hudi|deltaLake|azureBlobStorage|mongodb|mysql|postgresql|"
    r"redis|sqlite|jdbc|odbc|input|cluster|executable)\w*\s*\(",
    re.IGNORECASE,
)
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$")  # db.table or table


def _strip(sql):
    """Remove block/line comments, string literals, and backticks so keyword/table-fn scanning sees
    only structure (backticks stripped so `url`(…) normalizes to url(…) and can't evade _TABLE_FN)."""
    s = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)   # /* ... */
    s = re.sub(r"--[^\n]*", " ", s)                        # -- ... EOL
    s = re.sub(r"'(?:[^'\\]|\\.|'')*'", " ", s)            # '...' STRING literals (single-quote in ClickHouse)
    # Double-quote and backtick are IDENTIFIER quotes in ClickHouse (not strings) — strip only the quote
    # CHARS so the inner name survives the scan (else "url"(…) / `url`(…) evades _TABLE_FN → SSRF).
    s = s.replace("`", "").replace('"', "")
    return s


def _validate_identifier(name):
    """Defense-in-depth for the describe table arg: a bare `table` or `db.table` only."""
    if not _IDENTIFIER.match(name or ""):
        raise ValueError("invalid table identifier (expected table or db.table)")


def _assert_read_only(sql):
    stripped = _strip(sql or "")
    # stacked statements: more than one non-empty ;-separated part
    if len([p for p in stripped.split(";") if p.strip()]) > 1:
        raise ValueError("read-only: multiple statements are not allowed")
    tokens = stripped.strip().split()
    if not tokens or tokens[0].upper() not in _READ_VERBS:
        raise ValueError("read-only: only SELECT/WITH/SHOW/DESCRIBE/EXISTS queries are allowed")
    if _DANGER.search(stripped):
        raise ValueError("read-only: statement contains a disallowed (write/admin) keyword")
    if _TABLE_FN.search(stripped):
        raise ValueError("read-only: table functions (url/file/remote/s3/mysql/...) are not allowed")


def _clamp_rows(v):
    try:
        n = int(v)
    except (TypeError, ValueError):
        return DEFAULT_MAX_ROWS
    return max(1, min(MAX_ROWS_CAP, n))


def _run_sql(sql, max_rows):
    _assert_read_only(sql)
    ds = load_datasource(SLUG)
    assert_host_allowed(ds["endpoint"])
    base = ds["endpoint"].rstrip("/")
    url = f"{base}/?readonly=1&max_result_rows={max_rows}&default_format=JSON"
    headers = dict(auth_headers(ds))
    headers["Content-Type"] = "text/plain; charset=utf-8"
    body = f"{sql}\nFORMAT JSON"
    status, data = http_json("POST", url, headers=headers, body=body)
    if status >= 400:
        snippet = data.get("raw") or data.get("exception") or data
        return err(f"ClickHouse query failed ({status}): {str(snippet)[:300]}")
    rows = data.get("data", []) if isinstance(data, dict) else []
    return ok({"rowCount": len(rows[:max_rows]), "rows": rows[:max_rows],
               "meta": data.get("meta") if isinstance(data, dict) else None})


def clickhouse_query(args):
    sql = (args.get("sql") or "").strip()
    if not sql:
        return err("sql required")
    return _run_sql(sql, _clamp_rows(args.get("max_rows")))


def clickhouse_tables(args):
    return _run_sql("SHOW TABLES", _clamp_rows(args.get("max_rows")))


def clickhouse_describe(args):
    table = (args.get("table") or "").strip()
    if not table:
        return err("table required")
    _validate_identifier(table)  # defense-in-depth (the read-only guard also catches stacked stmts)
    return _run_sql(f"DESCRIBE TABLE {table}", _clamp_rows(args.get("max_rows")))


_TOOLS = {
    "clickhouse_query": clickhouse_query,
    "clickhouse_tables": clickhouse_tables,
    "clickhouse_describe": clickhouse_describe,
}


def lambda_handler(event, context):
    params = event if isinstance(event, dict) else json.loads(event)
    t = params.get("tool_name", "")
    args = params.get("arguments", params)
    if isinstance(args, dict):
        args.pop("target_account_id", None)  # ClickHouse is account-agnostic (HTTP endpoint)
    fn = _TOOLS.get(t)
    if fn is None:
        return err(f"unknown tool: {t}")
    try:
        return fn(args)
    except ValueError as e:
        return err(str(e))
    except NotConnected as e:
        return err(str(e))
    except SsrfBlocked as e:
        return err(str(e))
    except Exception as e:  # noqa: BLE001 — never leak a stack trace (or credentials) to the gateway
        return err(f"clickhouse error: {e}")


def ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str)}


def err(msg):
    return {"statusCode": 400, "body": json.dumps({"error": msg})}
