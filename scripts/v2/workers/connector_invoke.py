# scripts/v2/workers/connector_invoke.py
"""Credential-blind datasource-connector invoke + non-PII result summary. Extracted from
diagnosis/sources.py so BOTH the diagnosis worker and the incident AlertValidation Lambda share
ONE implementation (DRY). We NEVER send conn_config/credentials — the connector Lambda resolves
the per-instance secret SERVER-SIDE. summarize_result emits SIGNAL ONLY (count, result type,
metric LABEL NAMES) and NEVER raw samples (log lines / trace payloads / row values)."""
import json
import os

import boto3

REGION = os.environ.get("AWS_REGION", "ap-northeast-2")
PROJECT = os.environ.get("PROJECT", "awsops-v2")
# Bound a single connector invoke so one hung connector can't blow a caller's wall-clock budget
# (diagnosis has its own deadline; the incident AlertValidation deadline is ~25s). 1 retry only.
_TIMEOUT_S = float(os.environ.get("CONNECTOR_INVOKE_TIMEOUT_S", "10"))


def _lambda_client():
    from botocore.config import Config
    return boto3.client("lambda", region_name=REGION,
                        config=Config(connect_timeout=5, read_timeout=_TIMEOUT_S, retries={"max_attempts": 1}))


def invoke_connector(kind, tool, instance_id, arguments=None):
    """Credential-blind connector invoke: send ONLY {tool_name, arguments{instance_id,...}} — the
    connector resolves the per-instance secret SERVER-SIDE. We NEVER send conn_config/credentials.
    Returns (statusCode, body_dict)."""
    payload = {"tool_name": tool, "arguments": dict(arguments or {}, instance_id=instance_id)}
    r = _lambda_client().invoke(
        FunctionName=f"{PROJECT}-agent-{kind}-mcp",
        Payload=json.dumps(payload).encode("utf-8"),
    )
    # A Lambda FunctionError (unhandled exception / init failure) means the tool did NOT run — map
    # to a failing status so callers' `status >= 400` gate catches it. NEVER fall through to a 0,
    # which both callers read as success (`status >= 400` False; `if status and ...` falsy).
    if r.get("FunctionError"):
        return 502, {}
    raw = r["Payload"].read()
    out = json.loads(raw) if raw else {}
    body = out.get("body")
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except (ValueError, TypeError):
            body = {"raw": body[:300]}
    body = body if isinstance(body, dict) else {}
    # A well-formed connector envelope always carries an int statusCode. A missing/non-int one is a
    # malformed response → treat as failure (502), not 0 (the old default that slipped past the gate).
    status = out.get("statusCode")
    if not isinstance(status, int):
        return 502, body
    return status, body


def summarize_result(body):
    """Compact a connector result to NON-PII SIGNAL ONLY — count, result type, source key, and metric
    LABEL NAMES (keys, never values). Critically: NEVER emit raw samples. Loki `result` is raw log
    lines, Tempo `traces` are trace payloads, ClickHouse `rows` are raw row values; sampling any of
    those leaks PII into the Bedrock context (NO raw log lines; DLP / ADR-040/041). Handles the
    ACTUAL envelopes: prom/loki/clickhouse spread a top-level list (+resultType), Tempo returns
    `traces`; some shapes nest under `result:{series|...}`."""
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
