"""SG Rules & Usage — Athena/Glue broker Lambda (ADR-019 Role B isolation).

This is the ONLY principal in this repository allowed to `sts:AssumeRole` on the target account's
`AWSopsSgRuleAthenaRole` — the shared Fargate worker task role (worker_task, workers.tf) NEVER
gets that grant (ADR-019 §4 / the design spec's IAM section explicitly forbids it: granting it to
the shared role would expose every other job type this worker fleet runs to Athena/S3 access it
has no business needing). The Fargate worker (sg_rule_scan.py) and the web BFF (source validation,
web/lib/sg-rules.ts) both call this broker via `lambda:InvokeFunction` instead of assuming the
Athena role themselves — that grant is safe to give multiple callers because it does not confer
AssumeRole.

Trust-boundary redesign (L3 finding #6, round 2): earlier, `action: "query"` executed a verbatim
caller-supplied SQL string against caller-supplied account_id/region/workgroup/database — any
principal with `lambda:InvokeFunction` (the shared worker fleet AND the web BFF, per this module's
own docstring) could therefore read anything `AWSopsSgRuleAthenaRole` can reach in ANY trusting
account by supplying arbitrary parameters. That action is REMOVED. The only query-shaped action now
is `action: "query_by_source"`, which accepts ONLY an opaque `flow_source_id` (a row id in the
`sg_flow_sources` table) + a `day` (ISO date) — this module resolves account_id/region/workgroup/
database_name/table_name/validation/external_id from Aurora ITSELF (the same rds-db IAM-auth
pattern as db.py/sg_rule_dispatcher.py) and builds the day-SELECT server-side
(sg_rule_matching.build_day_select) from that resolved config. A caller can never inject its own
SQL, account, or table — it can only ask "run source #N's day-D query", and only a source whose
`validation.status == 'valid'` (fully validated, never 'pending') and whose validation resolved a
bound-able partition strategy is ever scanned (L3 finding #8).

Actions:
  - "validate": GetWorkGroup/GetDatabase/GetTable only (read-only existence + schema-resolution
    check backing the spec's "Flow Log source configuration" section, called by web/lib/sg-rules.ts
    BEFORE a flow_source_id even exists, so it still accepts raw account_id/region/workgroup/
    database/table — those are re-validated by strict identifier allowlists here regardless of
    what web/lib/sg-rules.ts already checked at PUT time). No query execution. Also requires the
    workgroup to enforce its own `BytesScannedCutoffPerQuery` (L3 finding #8c) — a workgroup without
    one fails validation outright, so AWS itself pre-emptively enforces a scan-bytes ceiling instead
    of relying solely on this module's own post-hoc check.
  - "query_by_source": resolves the source from Aurora, builds ONE Athena SELECT for one account/
    region/day partition server-side, and runs it: StartQueryExecution -> poll GetQueryExecution ->
    ONE bounded page of GetQueryResults -> return that page + a continuation token (L2 finding #4 —
    never accumulates and returns an unbounded row set synchronously; the caller,
    sg_rule_scan.py's invoke_broker_query, loops on the token until `done`). Also runs a cheap
    companion SKIPDATA-count query and, on an empty first page against a `partition_keys`-strategy
    table, verifies at least one Glue partition actually matched the day's predicate before trusting
    a zero-row result as "no traffic" (L4 finding #9).

Never executes a caller-supplied WHERE/column list, never runs anything but SELECT (the query
string this module itself built is still re-validated defense-in-depth — see _reject_non_select),
never touches CreateWorkGroup/CreateTable/DeleteTable/etc, and never writes S3 outside the
workgroup's own configured result location (that write is Athena's own intrinsic mechanic, not
something this module does directly).
"""
import datetime as _dt
import os
import re
import time

import boto3

import sg_rule_matching as sm

_STS_SESSION_NAME = "awsops-sg-rule-athena"
_POLL_INTERVAL_S = 1.0
_MAX_POLL_S = int(os.environ.get("SG_RULE_ATHENA_POLL_TIMEOUT_S", "120"))
_DEFAULT_MAX_BYTES = int(os.environ.get("SG_RULE_ACTIVITY_MAX_QUERY_BYTES", "107374182400"))  # 100 GiB
_ROLE_NAME = "AWSopsSgRuleAthenaRole"
_PAGE_SIZE = 1000  # Athena's own per-call GetQueryResults maximum.

# Defense-in-depth: even though the SQL run here is always built by THIS module from resolved,
# re-validated Aurora config (never a caller-supplied string), it is still re-checked before it
# ever reaches Athena — a second, structurally-different check in a different process/step.
_SELECT_ONLY_RE = re.compile(r"^\s*SELECT\b", re.IGNORECASE)
_FORBIDDEN_RE = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE|MERGE|TRUNCATE|CALL|VACUUM|UNLOAD|UNION)\b",
    re.IGNORECASE,
)

# Defense-in-depth (L3 trust-boundary finding): re-apply the SAME strict allowlist regexes
# web/lib/sg-rules.ts already enforces at PUT time to whatever this module reads back out of
# Aurora — a stored row is not automatically trustworthy just because something upstream validated
# it once; a second, structurally different check in a different process.
_GLUE_IDENT_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,127}$')
_WORKGROUP_RE = re.compile(r'^[A-Za-z0-9._-]{1,128}$')
_ACCOUNT_ID_RE = re.compile(r'^\d{12}$')
_REGION_RE = re.compile(r'^[a-z]{2,4}(-[a-z]+)+-\d$')
_DAY_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


class BrokerError(Exception):
    pass


def _validate_identifiers(account_id, region, workgroup, database, table=None, require_table=False):
    if not isinstance(account_id, str) or not _ACCOUNT_ID_RE.match(account_id):
        raise BrokerError("account_id must be a 12-digit AWS account id")
    if not isinstance(region, str) or not _REGION_RE.match(region):
        raise BrokerError("region must be a valid AWS region name")
    if not isinstance(workgroup, str) or not _WORKGROUP_RE.match(workgroup):
        raise BrokerError("workgroup must match the Athena workgroup-name charset")
    if not isinstance(database, str) or not _GLUE_IDENT_RE.match(database):
        raise BrokerError("database must be a valid Glue identifier")
    if require_table:
        if not isinstance(table, str) or not _GLUE_IDENT_RE.match(table):
            raise BrokerError("table must be a valid Glue identifier")


def _reject_non_select(sql):
    if not _SELECT_ONLY_RE.match(sql or ""):
        raise BrokerError("query must be a bare SELECT")
    if _FORBIDDEN_RE.search(sql):
        raise BrokerError("query contains a forbidden (mutating) keyword")


def _assumed_session(account_id, external_id, region):
    sts = boto3.client("sts", region_name=region)
    role_arn = f"arn:aws:iam::{account_id}:role/{_ROLE_NAME}"
    kwargs = {"RoleArn": role_arn, "RoleSessionName": _STS_SESSION_NAME, "DurationSeconds": 3600}
    if external_id:
        kwargs["ExternalId"] = external_id
    resp = sts.assume_role(**kwargs)
    c = resp["Credentials"]
    return boto3.Session(
        aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"],
        aws_session_token=c["SessionToken"], region_name=region,
    )


def _validate(event):
    account_id = event.get("account_id")
    region = event.get("region")
    workgroup = event.get("workgroup")
    database = event.get("database")
    table = event.get("table")
    _validate_identifiers(account_id, region, workgroup, database, table, require_table=True)
    external_id = event.get("external_id")
    session = _assumed_session(account_id, external_id, region)
    athena = session.client("athena")
    glue = session.client("glue")

    wg = athena.get_work_group(WorkGroup=workgroup)
    wg_config = wg.get("WorkGroup", {}).get("Configuration", {}) or {}
    result_config = wg_config.get("ResultConfiguration", {})
    if not result_config.get("OutputLocation"):
        raise BrokerError("workgroup has no configured query-results S3 location")
    # L3 finding #8c: require AWS itself to pre-emptively enforce a scan-bytes ceiling on this
    # workgroup, rather than relying solely on this module's own post-hoc (after Athena already
    # finished, cost already incurred) budget check.
    if not wg_config.get("BytesScannedCutoffPerQuery"):
        raise BrokerError("workgroup does not enforce a BytesScannedCutoffPerQuery — configure one before use")

    glue.get_database(Name=database)
    tbl = glue.get_table(DatabaseName=database, Name=table)["Table"]
    columns = [c["Name"].lower() for c in tbl.get("StorageDescriptor", {}).get("Columns", [])]
    # Canonical VPC Flow Log fields (+ their Athena underscore-normalized forms).
    required = {
        "interface_id": ["interface-id", "interface_id"],
        "srcaddr": ["srcaddr"], "dstaddr": ["dstaddr"],
        "srcport": ["srcport"], "dstport": ["dstport"],
        "protocol": ["protocol"], "action": ["action"], "log_status": ["log-status", "log_status"],
        "start": ["start"], "end": ["end"],
    }
    resolved = {}
    missing = []
    for canonical, aliases in required.items():
        hit = next((a for a in aliases if a.lower() in columns), None)
        if hit:
            resolved[canonical] = hit
        else:
            missing.append(canonical)
    if missing:
        raise BrokerError(f"table missing required Flow Log fields: {', '.join(missing)}")

    partition_keys = [c["Name"] for c in tbl.get("PartitionKeys", [])]
    projection_enabled = (tbl.get("Parameters", {}) or {}).get("projection.enabled") == "true"
    if not partition_keys and not projection_enabled:
        raise BrokerError("table has no partition keys or partition projection — cannot bound a scan")
    strategy = "projection" if projection_enabled else "partition_keys"

    optional_present = [c for c in ("flow-direction", "flow_direction", "tcp-flags", "tcp_flags",
                                    "bytes", "packets") if c.lower() in columns]
    return {
        "ok": True, "schemaFields": sorted(resolved.values()), "partitionStrategy": strategy,
        "optionalFields": optional_present,
        # The canonical -> actual-alias mapping AND the actual partition key names, persisted by
        # web/lib/sg-rules.ts into sg_flow_sources.validation so this module's own
        # `query_by_source` action (via sg_rule_matching.build_day_select) can use the REAL
        # resolved schema instead of hardcoding underscore names / an unbounded scan.
        "columnMap": resolved, "partitionKeys": partition_keys,
    }


# ── Aurora resolution (L3 finding #6): the broker now owns its own Aurora connectivity, mirroring
#    db.py/sg_rule_dispatcher.py's rds-db IAM-auth pattern — never a cached credential. ────────────

def _load_source_row(conn, flow_source_id):
    rows = conn.run(
        "SELECT account_id, region, workgroup, database_name, table_name, validation "
        "FROM sg_flow_sources WHERE id=:id", id=flow_source_id)
    if not rows:
        raise BrokerError(f"no sg_flow_sources row for id={flow_source_id!r}")
    r = rows[0]
    account_id, region, workgroup, database_name, table_name, validation = (
        r[0], r[1], r[2], r[3], r[4], r[5])
    if isinstance(validation, str):
        import json as _json
        try:
            validation = _json.loads(validation)
        except (ValueError, TypeError):
            validation = {}
    validation = validation or {}
    ext_rows = conn.run("SELECT external_id FROM accounts WHERE account_id=:a", a=account_id)
    external_id = ext_rows[0][0] if ext_rows else None
    return {
        "account_id": account_id, "region": region, "workgroup": workgroup,
        "database_name": database_name, "table_name": table_name, "validation": validation,
        "external_id": external_id,
    }


def _partition_exists(glue, database, table, day, validation):
    """Best-effort Glue GetPartitions check (L4 finding #9(iii)): before trusting a zero-row Athena
    result as "no traffic that day", confirm at least one partition actually matches the day's
    predicate — a wrong/guessed partition-key mapping can otherwise silently match zero partitions
    and look exactly like a genuine zero-traffic day. Only meaningful for the `partition_keys`
    strategy (partition projection has no enumerable Glue partitions to check); any Glue error is
    treated as "cannot verify" (True) rather than falsely claiming zero traffic on an API hiccup."""
    partition_keys = validation.get("partitionKeys") or []
    lower_keys = {k.lower(): k for k in partition_keys}
    try:
        if {"year", "month", "day"} <= set(lower_keys):
            y, mo, d = lower_keys["year"], lower_keys["month"], lower_keys["day"]
            expr = (f"{y} = '{day.year:04d}' AND {mo} = '{day.month:02d}' AND {d} = '{day.day:02d}'")
        elif len(partition_keys) == 1:
            expr = f"{partition_keys[0]} = '{day.isoformat()}'"
        else:
            return True  # not a checkable single/hive-style scheme — do not block on it
        resp = glue.get_partitions(DatabaseName=database, TableName=table, Expression=expr, MaxResults=1)
        return bool(resp.get("Partitions"))
    except Exception:  # noqa: BLE001 — an unverifiable check must never manufacture a false "no data"
        return True


def _run_athena_query(session, workgroup, database, sql, max_bytes):
    athena = session.client("athena")
    start = athena.start_query_execution(
        QueryString=sql, QueryExecutionContext={"Database": database}, WorkGroup=workgroup)
    qid = start["QueryExecutionId"]
    deadline = time.time() + _MAX_POLL_S
    status = None
    exec_ = {}
    scanned_bytes = 0
    while time.time() < deadline:
        exec_ = athena.get_query_execution(QueryExecutionId=qid)["QueryExecution"]
        status = exec_["Status"]["State"]
        scanned_bytes = int((exec_.get("Statistics") or {}).get("DataScannedInBytes") or 0)
        if status in ("SUCCEEDED", "FAILED", "CANCELLED"):
            break
        time.sleep(_POLL_INTERVAL_S)
    else:
        try:
            athena.stop_query_execution(QueryExecutionId=qid)
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "reason": "poll deadline exceeded", "query_execution_id": qid}

    if status != "SUCCEEDED":
        reason = (exec_.get("Status", {}) or {}).get("StateChangeReason", status)
        return {"ok": False, "reason": reason, "query_execution_id": qid, "status": status}

    if scanned_bytes > max_bytes:
        return {
            "ok": False, "reason": "scan-bytes budget exceeded", "query_execution_id": qid,
            "data_scanned_bytes": scanned_bytes,
        }
    return {"ok": True, "query_execution_id": qid, "data_scanned_bytes": scanned_bytes, "athena": athena}


def _fetch_page(athena, qid, next_token, first_page):
    kwargs = {"QueryExecutionId": qid, "MaxResults": _PAGE_SIZE}
    if next_token:
        kwargs["NextToken"] = next_token
    page = athena.get_query_results(**kwargs)
    result_rows = page["ResultSet"]["Rows"]
    columns = None
    if first_page:
        if result_rows:
            columns = [c.get("VarCharValue") for c in result_rows[0]["Data"]]
        result_rows = result_rows[1:]
    rows = []
    for r in result_rows:
        values = [c.get("VarCharValue") for c in r["Data"]]
        rows.append(values)
    return columns, rows, page.get("NextToken")


def _rows_as_dicts(columns, raw_rows):
    return [dict(zip(columns or [], values)) for values in raw_rows]


def _query_by_source(event, conn):
    flow_source_id = event.get("flow_source_id")
    day_str = event.get("day")
    if not isinstance(flow_source_id, int) or isinstance(flow_source_id, bool) or flow_source_id <= 0:
        raise BrokerError("flow_source_id must be a positive integer")
    if not isinstance(day_str, str) or not _DAY_RE.match(day_str):
        raise BrokerError("day must be an ISO date string (YYYY-MM-DD)")
    day = _dt.date.fromisoformat(day_str)
    max_bytes = min(int(event.get("max_bytes") or _DEFAULT_MAX_BYTES), _DEFAULT_MAX_BYTES)

    source = _load_source_row(conn, flow_source_id)
    _validate_identifiers(source["account_id"], source["region"], source["workgroup"],
                           source["database_name"], source["table_name"], require_table=True)

    continuation = event.get("continuation")
    if continuation:
        qid = continuation.get("query_execution_id")
        columns = continuation.get("columns")
        if not qid:
            raise BrokerError("continuation.query_execution_id is required")
        session = _assumed_session(source["account_id"], source["external_id"], source["region"])
        athena = session.client("athena")
        _, raw_rows, next_token = _fetch_page(athena, qid, continuation.get("next_token"), first_page=False)
        return {
            "ok": True, "rows": _rows_as_dicts(columns, raw_rows), "columns": columns,
            "query_execution_id": qid, "next_token": next_token, "done": next_token is None,
        }

    validation = source["validation"]
    status = validation.get("status")
    if status != "valid":
        # L3 finding #8a: a 'pending' (or any other non-'valid') source has never been fully
        # confirmed against the real table schema — it must not be scanned.
        return {"ok": False, "reason": f"source validation.status={status!r} is not 'valid' — refusing to scan"}
    if not sm.has_resolved_partition_strategy(validation):
        # L3 finding #8b: no resolved bound means an unbounded full-table scan — refuse outright
        # rather than silently falling back to one.
        return {"ok": False, "reason": "validation did not resolve a partition strategy — refusing an unbounded scan"}

    try:
        sql = sm.build_day_select(source, day)
    except sm.UnsafeIdentifier as e:
        raise BrokerError(f"unsafe identifier in resolved source config: {e}")
    _reject_non_select(sql)

    session = _assumed_session(source["account_id"], source["external_id"], source["region"])
    result = _run_athena_query(session, source["workgroup"], source["database_name"], sql, max_bytes)
    if not result.get("ok"):
        return result
    athena = result.pop("athena")
    columns, raw_rows, next_token = _fetch_page(athena, result["query_execution_id"], None, first_page=True)

    if not raw_rows and not next_token:
        # L4 finding #9(iii): before trusting an empty result as "no traffic", verify the partition
        # predicate actually matched something (only meaningful for the enumerable partition_keys
        # strategy — partition projection has no Glue partitions to check).
        if validation.get("partitionStrategy") == "partition_keys" or (
                validation.get("partitionKeys") and not (validation.get("optionalFields") is None)):
            glue = session.client("glue")
            if not _partition_exists(glue, source["database_name"], source["table_name"], day, validation):
                return {
                    "ok": False,
                    "reason": "zero Glue partitions matched the day's predicate — likely a wrong "
                              "partition-key mapping, not a genuine zero-traffic day",
                    "zero_partition_match": True,
                }

    skipdata_count = None
    try:
        skip_sql = sm.build_day_skipdata_count_select(source, day)
        skip_result = _run_athena_query(session, source["workgroup"], source["database_name"], skip_sql, max_bytes)
        if skip_result.get("ok"):
            skip_athena = skip_result.pop("athena")
            _, skip_rows, _ = _fetch_page(skip_athena, skip_result["query_execution_id"], None, first_page=True)
            if skip_rows and skip_rows[0]:
                skipdata_count = int(skip_rows[0][0] or 0)
    except Exception:  # noqa: BLE001 — the SKIPDATA coverage signal is best-effort, never fatal
        skipdata_count = None

    return {
        "ok": True, "rows": _rows_as_dicts(columns, raw_rows), "columns": columns,
        "query_execution_id": result["query_execution_id"], "next_token": next_token,
        "done": next_token is None, "data_scanned_bytes": result.get("data_scanned_bytes"),
        "skipdata_count": skipdata_count,
    }


def lambda_handler(event, _ctx, conn_factory=None):
    action = event.get("action")
    try:
        if action == "validate":
            return _validate(event)
        if action == "query_by_source":
            import db  # deferred: only this action needs Aurora/pg8000 connectivity
            conn = (conn_factory or db.connect)()
            try:
                return _query_by_source(event, conn)
            finally:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass
        return {"ok": False, "reason": f"unknown action: {action!r}"}
    except BrokerError as e:
        return {"ok": False, "reason": str(e)}
    except Exception as e:  # noqa: BLE001 — never let a raw AWS exception leak un-shaped
        return {"ok": False, "reason": f"{type(e).__name__}: {e}"}
