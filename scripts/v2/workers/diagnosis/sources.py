"""AWSops v2 — AI Diagnosis native source collectors (read-only, PII-minimizing).
Each collect_* returns {"key","ok","degraded","notes","data"} and NEVER raises:
a failure degrades gracefully so a report still renders with a 'data unavailable' note.
Sources: Aurora inventory, CloudWatch metrics, Cost Explorer, Security Hub/Config posture,
X-Ray service map (actual traffic flow), CloudTrail what-changed. NO raw log lines.
"""
import os
import re
import json
import logging
import time as _time
import boto3
from botocore.exceptions import ClientError

import db as wdb  # noqa: F401 — worker db (parent dir, flat /app layout); reserved for future DB seams

REGION = os.environ.get("AWS_REGION", "ap-northeast-2")
PROJECT = os.environ.get("PROJECT", "awsops-v2")

# Datasource (external observability) collector bounds — schema-driven, credential-blind, read-only.
_DS_KINDS = ("prometheus", "mimir", "loki", "tempo", "clickhouse")
_DS_MAX_INSTANCES_PER_KIND = int(os.environ.get("DIAG_DS_MAX_INSTANCES_PER_KIND", "1"))  # default: is_default only
_DS_MAX_QUERIES_PER_INSTANCE = int(os.environ.get("DIAG_DS_MAX_QUERIES", "3"))
_DS_DEADLINE_S = float(os.environ.get("DIAG_DS_DEADLINE_S", "8"))
_DS_MAX_BYTES = 8000  # structural summarize-before-LLM hard cap on the collector's data blob
# Signal-bearing series we care about for intended-vs-actual (GENERIC patterns; the actual NAMES
# always come from the cached schema — we never hardcode a metric name).
_SIGNAL_RE = re.compile(r"(error|fail|5xx|request|latenc|duration|cpu|mem|saturat|throttl|drop)", re.I)
_COUNTERISH_RE = re.compile(r"(total|count|errors?|requests?)$", re.I)
# A bare SQL identifier — table names come from the datasource's own introspection, but we still
# validate before interpolating (a poisoned schema cache / crafted table name must not inject SQL).
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

_THROTTLE_CODES = (
    "Throttling", "ThrottlingException", "TooManyRequestsException", "RequestLimitExceeded",
)


def _result(key, ok=True, data=None, degraded=False, notes=""):
    return {"key": key, "ok": ok, "degraded": degraded, "notes": notes, "data": data or {}}


def _classify(key, exc):
    """Distinguish a throttled/failed call (loud) from an unconfigured service (quiet).
    A throttle or any ClientError marks data with `_failed` so the report status becomes
    'partial' and a loud failure line surfaces — never a false all-clear."""
    code = ""
    if isinstance(exc, ClientError):
        code = exc.response.get("Error", {}).get("Code", "")
    if code in _THROTTLE_CODES:
        return _result(key, ok=False, degraded=True, notes=f"THROTTLED: {code}", data={"_failed": True})
    if code:
        return _result(key, ok=False, degraded=True, notes=f"FAILED: {code}", data={"_failed": True})
    return _result(key, ok=False, degraded=True, notes=str(exc), data={"_failed": True})


# Wrapped so tests can monkeypatch a single seam per service.
def _ce_client():
    return boto3.client("ce", region_name=REGION)


def _cw_client():
    return boto3.client("cloudwatch", region_name=REGION)


def _xray_client():
    return boto3.client("xray", region_name=REGION)


def _ct_client():
    return boto3.client("cloudtrail", region_name=REGION)


def _sh_client():
    return boto3.client("securityhub", region_name=REGION)


def collect_inventory(conn):
    """Aurora inventory_resources counts by type (already synced; no live AWS call)."""
    try:
        rows = conn.run(
            "SELECT resource_type, count(*) FROM inventory_resources GROUP BY resource_type ORDER BY 2 DESC"
        )
        return _result("inventory", data={"by_type": {r[0]: int(r[1]) for r in rows}})
    except Exception as e:  # noqa: BLE001 — degrade, never raise
        return _classify("inventory", e)


def collect_cw_metrics(conn):
    """CloudWatch AWS/EC2 CPUUtilization (avg) per instance, ids pulled from inventory_resources.
    No raw log lines — aggregated metric statistics only. Degrades gracefully."""
    try:
        import datetime as dt
        # Instance ids from the already-synced inventory (no live describe needed).
        try:
            rows = conn.run(
                "SELECT resource_id FROM inventory_resources "
                "WHERE resource_type = 'ec2' AND account_id = 'self' LIMIT 50"
            )
            instance_ids = [r[0] for r in rows if r and r[0]]
        except Exception:  # noqa: BLE001 — inventory shape varies; tolerate
            instance_ids = []
        if not instance_ids:
            return _result("cw_metrics", data={"by_instance": {}, "avg_cpu": None},
                           notes="no ec2 instance ids in inventory")
        cw = _cw_client()
        end = dt.datetime.utcnow()
        start = end - dt.timedelta(hours=3)
        queries = [
            {
                "Id": f"cpu{i}",
                "MetricStat": {
                    "Metric": {
                        "Namespace": "AWS/EC2",
                        "MetricName": "CPUUtilization",
                        "Dimensions": [{"Name": "InstanceId", "Value": iid}],
                    },
                    "Period": 3600,
                    "Stat": "Average",
                },
                "ReturnData": True,
            }
            for i, iid in enumerate(instance_ids)
        ]
        r = cw.get_metric_data(MetricDataQueries=queries, StartTime=start, EndTime=end)
        by_instance = {}
        for i, iid in enumerate(instance_ids):
            for mr in r.get("MetricDataResults", []):
                if mr.get("Id") == f"cpu{i}":
                    vals = mr.get("Values", [])
                    by_instance[iid] = round(sum(vals) / len(vals), 2) if vals else None
        nums = [v for v in by_instance.values() if v is not None]
        avg_cpu = round(sum(nums) / len(nums), 2) if nums else None
        return _result("cw_metrics", data={"by_instance": by_instance, "avg_cpu": avg_cpu})
    except Exception as e:  # noqa: BLE001
        return _classify("cw_metrics", e)


def collect_cost():
    """Cost Explorer MTD by service (aggregated $; no PII). Read-only GetCostAndUsage."""
    try:
        ce = _ce_client()
        import datetime as dt
        today = dt.date.today()
        start = today.replace(day=1).isoformat()
        end = (today + dt.timedelta(days=1)).isoformat()
        r = ce.get_cost_and_usage(
            TimePeriod={"Start": start, "End": end}, Granularity="MONTHLY",
            Metrics=["UnblendedCost"], GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
        groups = r.get("ResultsByTime", [{}])[0].get("Groups", [])
        by_service = {g["Keys"][0]: float(g["Metrics"]["UnblendedCost"]["Amount"]) for g in groups}
        return _result("cost", data={"mtd_by_service": by_service})
    except Exception as e:  # noqa: BLE001
        return _classify("cost", e)


def collect_service_map():
    """X-Ray service graph = actual traffic flow (topology + RED metrics). No log payloads."""
    try:
        import datetime as dt
        xr = _xray_client()
        end = dt.datetime.utcnow()
        start = end - dt.timedelta(hours=3)
        g = xr.get_service_graph(StartTime=start, EndTime=end)
        edges = []
        for svc in g.get("Services", []):
            name = svc.get("Name")
            for e in svc.get("Edges", []):
                s = e.get("SummaryStatistics", {})
                edges.append({
                    "from": name, "to_ref": e.get("ReferenceId"),
                    "calls": s.get("TotalCount", 0),
                    "error_rate": round((s.get("ErrorStatistics", {}).get("TotalCount", 0)
                                         / s["TotalCount"]) if s.get("TotalCount") else 0, 4),
                })
        return _result("service_map", data={"edges": edges, "service_count": len(g.get("Services", []))})
    except Exception as e:  # noqa: BLE001
        return _classify("service_map", e)


def collect_posture():
    """Security Hub active findings rollup by severity (CIS/best-practice). No PII.

    Security Hub is opt-in. When the account isn't subscribed, get_findings raises
    InvalidAccessException — that is a known steady state, NOT a failure. Report it
    quietly as `enabled: false` so the section narrates "Security Hub 미구독" instead of
    a scary "_failed" (which otherwise degrades every report to 'partial')."""
    try:
        sh = _sh_client()
        r = sh.get_findings(
            Filters={"RecordState": [{"Value": "ACTIVE", "Comparison": "EQUALS"}],
                     "WorkflowStatus": [{"Value": "NEW", "Comparison": "EQUALS"}]},
            MaxResults=100,
        )
        by_sev = {}
        for f in r.get("Findings", []):
            sev = f.get("Severity", {}).get("Label", "UNKNOWN")
            by_sev[sev] = by_sev.get(sev, 0) + 1
        return _result("posture", data={"enabled": True, "findings_by_severity": by_sev})
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "InvalidAccessException":
            return _result("posture", ok=True, degraded=False,
                           notes="Security Hub not subscribed in this account/region",
                           data={"enabled": False, "findings_by_severity": {}})
        return _classify("posture", e)
    except Exception as e:  # noqa: BLE001
        return _classify("posture", e)


def collect_what_changed():
    """CloudTrail management-event change summary (last 24h). PII-stripped: each event is mapped
    to {name, source, time} ONLY — Username/identity, Resources, and request params are dropped
    at the collector so they never reach the report context."""
    try:
        import datetime as dt
        ct = _ct_client()
        end = dt.datetime.utcnow()
        start = end - dt.timedelta(hours=24)
        r = ct.lookup_events(
            LookupAttributes=[{"AttributeKey": "ReadOnly", "AttributeValue": "false"}],
            StartTime=start, EndTime=end, MaxResults=50,
        )
        events = [{"name": e.get("EventName"), "source": e.get("EventSource"),
                   "time": e.get("EventTime").isoformat() if e.get("EventTime") else None}
                  for e in r.get("Events", [])]
        return _result("what_changed", data={"recent_changes": events})
    except Exception as e:  # noqa: BLE001
        return _classify("what_changed", e)


# ── External observability datasources (multi-instance, schema-driven, credential-blind) ───────────
def _lambda_client():
    return boto3.client("lambda", region_name=REGION)


def _invoke_connector(kind, tool, instance_id, arguments=None):
    """Credential-blind connector invoke: send ONLY {tool_name, arguments{instance_id,...}} — the
    connector resolves the per-instance secret SERVER-SIDE. We NEVER send conn_config/credentials.
    Returns (statusCode, body_dict)."""
    payload = {"tool_name": tool, "arguments": dict(arguments or {}, instance_id=instance_id)}
    r = _lambda_client().invoke(
        FunctionName=f"{PROJECT}-agent-{kind}-mcp",
        Payload=json.dumps(payload).encode("utf-8"),
    )
    raw = r["Payload"].read()
    out = json.loads(raw) if raw else {}
    body = out.get("body")
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except (ValueError, TypeError):
            body = {"raw": body[:300]}
    return out.get("statusCode", 0), (body if isinstance(body, dict) else {})


def _ds_schema(conn, integration_id):
    """Cached introspected schema for one instance. PREFERS the BFF's account-key convention
    (host account ∪ 'self', exact-account first) per spec §8, then FALLS BACK to integration_id alone
    so a worker/BFF account-key mismatch doesn't blank the collector. This is a PREFERENCE, NOT an
    enforced cross-tenant boundary — it is safe ONLY because `integrations` is single-account (the
    table has no account_id, so one integration_id = exactly one instance); the fallback logs a
    key-mismatch smell. (If this ever becomes multi-tenant, remove the fallback and enforce isolation upstream.)"""
    acct = os.environ.get("HOST_ACCOUNT_ID") or os.environ.get("AWS_ACCOUNT_ID") or "self"
    rows = conn.run(
        "SELECT schema FROM datasource_schemas WHERE account_id IN (:acct, 'self') AND integration_id=:iid "
        "ORDER BY (account_id = :acct) DESC, fetched_at DESC LIMIT 1",  # exact account wins over 'self'
        acct=acct, iid=integration_id,
    )
    if not rows:
        # Account-scope miss → fall back to integration_id alone. integrations is single-account
        # (the table has no account_id), so a given integration_id maps to ONE instance — this avoids a
        # functional regression when the worker's account env differs from the BFF's write key, while
        # still PREFERRING the account match above. Log the key-mismatch smell (spec §8).
        rows = conn.run(
            "SELECT schema FROM datasource_schemas WHERE integration_id=:iid ORDER BY fetched_at DESC LIMIT 1",
            iid=integration_id,
        )
        if rows:
            logging.warning("[diagnosis] datasource %s schema not under account (%r,'self') — using "
                            "integration_id fallback (BFF/worker account-key mismatch)", integration_id, acct)
    if not rows:
        return None
    s = rows[0][0]
    if isinstance(s, str):
        try:
            s = json.loads(s)
        except (ValueError, TypeError):
            return None
    return s if isinstance(s, dict) else None


def _plan_queries(kind, schema):
    """Derive ≤N narrow, AGGREGATED queries from the CACHED schema names (never hardcoded names).
    version (schema['version']) informs syntax only where a query is known to diverge. Returns
    [(tool, arguments, label)]."""
    plan = []
    if kind in ("prometheus", "mimir"):
        metrics = [m for m in (schema.get("metrics") or []) if isinstance(m, str)]
        picked = [m for m in metrics if _SIGNAL_RE.search(m)][:_DS_MAX_QUERIES_PER_INSTANCE]
        tool = "prometheus_query" if kind == "prometheus" else "mimir_query"
        for m in picked:
            expr = f"topk(5, sum by (job)(rate({m}[5m])))" if _COUNTERISH_RE.search(m) else f"topk(5, {m})"
            plan.append((tool, {"query": expr}, m))
    elif kind == "loki":
        labels = [l for l in (schema.get("labels") or []) if isinstance(l, str)]
        sel = next((l for l in labels if l in ("app", "namespace", "job", "service_name", "container")),
                   labels[0] if labels else None)
        if sel:
            q = '{%s=~".+"} |~ `(?i)(error|exception|fatal)`' % sel
            plan.append(("loki_query_range", {"query": f"count_over_time({q}[5m])"}, "error_logs"))
    elif kind == "tempo":
        plan.append(("tempo_search", {"query": "{ status = error }", "limit": 20}, "error_traces"))
    elif kind == "clickhouse":
        tables = schema.get("tables") or []
        names = [t.get("name") if isinstance(t, dict) else t for t in tables]
        # identifier-validate before interpolating — skip any name that isn't a bare identifier (no
        # SQL injection via a crafted/poisoned table name; clickhouse can't bind identifiers).
        safe = [x for x in names if isinstance(x, str) and _IDENT_RE.match(x)]
        for n in safe[:_DS_MAX_QUERIES_PER_INSTANCE]:
            plan.append(("clickhouse_query", {"sql": f"SELECT count() AS c FROM {n}"}, n))
    return plan[:_DS_MAX_QUERIES_PER_INSTANCE]


def _summarize_result(body):
    """Compact a connector result to NON-PII SIGNAL ONLY — count, result type, source key, and metric
    LABEL NAMES (keys, never values). Critically: NEVER emit raw samples. Loki `result` is raw log
    lines, Tempo `traces` are trace payloads, ClickHouse `rows` are raw row values; sampling any of
    those leaks PII into the Bedrock context (module docstring 'NO raw log lines' + DLP / ADR-040/041).
    Handles the ACTUAL envelopes: prom/loki/clickhouse spread a top-level list (+resultType), Tempo
    returns `traces`; some shapes nest under `result:{series|...}`."""
    out = {}
    if not isinstance(body, dict):
        return out
    # top-level list-bearing key (prom/loki `result`, tempo `traces`, clickhouse `rows`, generic `data`/`series`)
    for key in ("result", "traces", "rows", "data", "series"):
        v = body.get(key)
        if isinstance(v, list):
            out["source"], out["count"] = key, len(v)
            # non-PII metadata only: the union of metric LABEL NAMES (keys), NEVER their values
            names = set()
            for item in v[:50]:
                m = item.get("metric") if isinstance(item, dict) else None
                if isinstance(m, dict):
                    names.update(str(k) for k in m.keys())
            if names:
                out["labels"] = sorted(names)[:25]
            break
    # nested {result:{series|rows|data}} (synthetic/aggregated shapes) — count + shape only, NO samples
    if "count" not in out:
        res = body.get("result")
        if isinstance(res, dict):
            series = res.get("series") or res.get("rows") or res.get("data")
            if isinstance(series, list):
                out["count"] = len(series)
            if "shape" in res:
                out["shape"] = res.get("shape")
    if "resultType" in body:
        out["resultType"] = body.get("resultType")
    return out


def collect_datasources(conn):
    """Schema-driven, multi-instance, credential-blind external-observability signals for diagnosis.
    Reads ONLY non-secret integrations columns + the cached schema; invokes connectors credential-blind
    (instance_id only). Bounded (instances/queries/deadline/bytes). NEVER raises.

    FLAG-GATED (CLAUDE.md: gate new features, default OFF → $0): runs only when DIAG_DATASOURCES_ENABLED
    is set. The terraform var `datasource_diagnosis_enabled` wires this env AND the worker
    lambda:InvokeFunction IAM together (ADR-039/041 governed external egress), so the connector fan-out
    can never be live without its IAM — no silent AccessDenied degrade."""
    if os.environ.get("DIAG_DATASOURCES_ENABLED") != "true":
        return _result("datasources_obs", data={"instances": [], "queried": 0},
                       notes="datasource diagnosis disabled (datasource_diagnosis_enabled flag off)")
    try:
        rows = conn.run(
            "SELECT id, name, kind, is_default FROM integrations "
            "WHERE direction='egress' AND capability='read' AND enabled=true "
            "AND kind IN ('prometheus','mimir','loki','tempo','clickhouse') "
            "ORDER BY kind, is_default DESC, id"
        )
    except Exception as e:  # noqa: BLE001
        return _classify("datasources_obs", e)

    by_kind = {}
    for r in rows or []:
        by_kind.setdefault(r[2], []).append(r)
    instances = []
    for _kind, lst in by_kind.items():
        instances.extend(lst[:_DS_MAX_INSTANCES_PER_KIND])  # default-first (ORDER BY is_default DESC)

    if not instances:
        return _result("datasources_obs", data={"instances": [], "queried": 0},
                       notes="no connected observability datasources")

    deadline = _time.time() + _DS_DEADLINE_S
    findings, notes = [], []
    for (iid, name, kind, is_default) in instances:
        if _time.time() > deadline:
            notes.append("time-budget exceeded; remaining datasources skipped")
            break
        schema = _ds_schema(conn, iid)
        if not schema:
            notes.append(f"{name} ({kind}): no cached schema — run Refresh schema")
            continue
        plan = _plan_queries(kind, schema)
        if not plan:
            notes.append(f"{name} ({kind}): schema has no signal-bearing series")
            continue
        results = []
        for (tool, args, label) in plan:
            if _time.time() > deadline:
                notes.append(f"{name}: time-budget exceeded mid-instance")
                break
            try:
                status, body = _invoke_connector(kind, tool, iid, args)
                if status and status >= 400:
                    results.append({"label": label, "error": (body.get("error") or f"HTTP {status}")})
                else:
                    results.append({"label": label, "summary": _summarize_result(body)})
            except Exception as e:  # noqa: BLE001 — per-query isolation; one bad query never sinks the rest
                results.append({"label": label, "error": type(e).__name__})
        findings.append({"name": name, "kind": kind, "version": schema.get("version"),
                         "is_default": bool(is_default), "results": results})

    data = {"instances": [{"name": f["name"], "kind": f["kind"]} for f in findings],
            "queried": len(findings), "findings": findings}
    if notes:
        data["notes"] = notes
    if len(json.dumps(data)) > _DS_MAX_BYTES:  # summarize-before-LLM hard cap: shed samples if oversized
        for f in findings:
            for rr in f.get("results", []):
                rr.pop("summary", None)
        data["_truncated"] = True
    return _result("datasources_obs", data=data, notes="; ".join(notes)[:300])


# Ordered registry of native collectors. `conn` is passed only to DB-backed ones.
def collect_all(conn):
    return [
        collect_inventory(conn),
        collect_cw_metrics(conn),
        collect_cost(),
        collect_service_map(),
        collect_datasources(conn),  # external observability (schema-driven, credential-blind)
        collect_posture(),
        collect_what_changed(),
    ]
