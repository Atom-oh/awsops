"""
Prometheus read-only MCP Lambda — PromQL instant/range queries + label/series discovery against a
user-registered Prometheus endpoint. Second of the v1 datasource family; uses the shared
datasource_http helper (credential load, SSRF host guard, auth, no-redirect HTTP).

READ-ONLY by construction: the Prometheus HTTP query API (/api/v1/query[_range], /labels, /series)
only evaluates PromQL / reads metadata — it cannot write and PromQL cannot trigger server-side
fetches, so (unlike ClickHouse SQL) there is no statement guard / table-function class. The only
attack surface is the endpoint, guarded by datasource_http.assert_host_allowed (+ endpoint SSRF
validation on credential save). Stdlib + boto3 only.
"""
import json
import re
import time
from urllib.parse import urlencode

from datasource_http import (
    NotConnected,
    SsrfBlocked,
    assert_host_allowed,
    auth_headers,
    http_json,
    load_datasource,
)

SLUG = "prometheus"
MAX_SERIES = 50
MAX_POINTS_PER_SERIES = 500
MAX_TOTAL_SAMPLES = 5000

_REL = re.compile(r"^(\d+)([smhdw])$")
_UNIT = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}


def _now():
    return int(time.time())


def _parse_time(v, default_delta=None):
    """now (default) / '1h'/'30m'/'2d' (now-delta) / ISO-ish or unix passthrough → unix-seconds string."""
    if v is None:
        if default_delta:
            return str(_now() - default_delta)
        return str(_now())
    s = str(v).strip()
    m = _REL.match(s)
    if m:
        return str(_now() - int(m.group(1)) * _UNIT[m.group(2)])
    return s  # caller-supplied ISO/unix passthrough (Prometheus accepts RFC3339 or unix)


def _ds():
    creds = load_datasource(SLUG)
    assert_host_allowed(creds["endpoint"])
    return creds


def _get(creds, path, params):
    url = creds["endpoint"].rstrip("/") + path + ("?" + urlencode(params, doseq=True) if params else "")
    status, data = http_json("GET", url, headers=auth_headers(creds))
    if status >= 400:
        raise _ApiError(f"Prometheus HTTP {status}: {str(data.get('raw') or data.get('error') or data)[:300]}")
    if isinstance(data, dict) and data.get("status") and data.get("status") != "success":
        raise _ApiError(f"Prometheus query failed ({data.get('errorType', 'error')}): {data.get('error', 'unknown')}")
    return data.get("data") if isinstance(data, dict) else data


class _ApiError(Exception):
    pass


def _bound(data):
    """Cap series, points-per-series, and a global sample budget for matrix/vector results."""
    if not isinstance(data, dict):
        return data, False
    result = data.get("result")
    if not isinstance(result, list):
        return data, False
    truncated = len(result) > MAX_SERIES
    result = result[:MAX_SERIES]
    budget = MAX_TOTAL_SAMPLES
    out = []
    for series in result:
        s = dict(series)
        vals = s.get("values")
        if isinstance(vals, list):
            if len(vals) > MAX_POINTS_PER_SERIES:
                truncated = True
            allowed = min(MAX_POINTS_PER_SERIES, max(0, budget))
            if len(vals) > allowed:
                truncated = True
            s["values"] = vals[:allowed]
            budget -= len(s["values"])
        out.append(s)
    return {"resultType": data.get("resultType"), "result": out}, truncated


def prometheus_query(args):
    query = (args.get("query") or "").strip()
    if not query:
        return err("query (PromQL) required")
    data = _get(_ds(), "/api/v1/query", {"query": query, "time": _parse_time(args.get("time"))})
    bounded, truncated = _bound(data)
    return ok({"truncated": truncated, **(bounded if isinstance(bounded, dict) else {"result": bounded})})


def prometheus_query_range(args):
    query = (args.get("query") or "").strip()
    if not query:
        return err("query (PromQL) required")
    start = _parse_time(args.get("start"), default_delta=3600)
    end = _parse_time(args.get("end"))
    step = str(args.get("step") or "60").strip()
    data = _get(_ds(), "/api/v1/query_range", {"query": query, "start": start, "end": end, "step": step})
    bounded, truncated = _bound(data)
    return ok({"truncated": truncated, **(bounded if isinstance(bounded, dict) else {"result": bounded})})


def prometheus_labels(args):
    data = _get(_ds(), "/api/v1/labels", {})
    names = data if isinstance(data, list) else []
    return ok({"labels": names[:1000], "truncated": len(names) > 1000})


def prometheus_series(args):
    match = (args.get("match") or "").strip()
    if not match:
        return err("match (series selector) required")
    data = _get(_ds(), "/api/v1/series", {"match[]": match})
    series = data if isinstance(data, list) else []
    return ok({"series": series[:MAX_SERIES], "truncated": len(series) > MAX_SERIES})


def prometheus_schema(args):
    creds = _ds()
    base = "/api/v1"
    try:
        labels = _get(creds, f"{base}/labels", {})
    except _ApiError:
        labels = []
    try:
        metrics = _get(creds, f"{base}/label/__name__/values", {})
    except _ApiError:
        metrics = []
    labels = labels if isinstance(labels, list) else []
    metrics = metrics if isinstance(metrics, list) else []
    return ok({"metrics": metrics[:500], "labels": labels[:200],
               "truncated": len(metrics) > 500 or len(labels) > 200})


_TOOLS = {
    "prometheus_query": prometheus_query,
    "prometheus_query_range": prometheus_query_range,
    "prometheus_labels": prometheus_labels,
    "prometheus_series": prometheus_series, "prometheus_schema": prometheus_schema,
}


def lambda_handler(event, context):
    params = event if isinstance(event, dict) else json.loads(event)
    t = params.get("tool_name", "")
    args = params.get("arguments", params)
    if isinstance(args, dict):
        args.pop("target_account_id", None)  # account-agnostic (HTTP endpoint)
    fn = _TOOLS.get(t)
    if fn is None:
        return err(f"unknown tool: {t}")
    try:
        return fn(args)
    except (NotConnected, SsrfBlocked, _ApiError) as e:
        return err(str(e))
    except Exception as e:  # noqa: BLE001 — never leak a stack trace / credentials
        return err(f"prometheus error: {e}")


def ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str)}


def err(msg):
    return {"statusCode": 400, "body": json.dumps({"error": msg})}
