"""Hybrid LLM fallback for signal_catalog.py — invoked by datasource_index.py ONLY when a kind's
deterministic catalog (build_signals) matched zero ready rows, i.e. the instance's schema doesn't
overlap the curated per-kind vocabulary at all (a custom/non-standard instrumentation). Mirrors
graph_querygen.py's pipeline exactly, generalized across query languages (PromQL/LogQL/TraceQL/SQL/
metricSelector) instead of one hardcoded ClickHouse SQL shape.

Gated on GRAPH_QUERYGEN_ENABLED (shared with graph_querygen.py — same on/off intent: "is generation
allowed at all"); never raises; returns None on ANY failure at any stage, so the caller's signal
just stays absent (the deterministic catalog's own `unavailable` rows are the safe fallback).

Validation pipeline (a) static keyword guard (kind-appropriate — only clickhouse's SQL surface has
mutating verbs to reject; other query languages have none, so the check is a structural/blank check
only) and (b) a live dry-run against the connector, asserting a non-error response.
"""
import json
import logging
import os
import re

_FORBIDDEN_SQL_KEYWORDS = (
    "insert", "update", "delete", "drop", "alter", "create", "truncate", "grant", "revoke",
    "attach", "detach", "rename", "optimize", "system", "kill", "exchange",
)

_KIND_TOOL = {
    "prometheus": "prometheus_query", "mimir": "mimir_query", "loki": "loki_query_range",
    "tempo": "tempo_search", "jaeger": "jaeger_search", "clickhouse": "clickhouse_query",
    "dynatrace": "dynatrace_query", "datadog": "datadog_query",
}

_VOCAB_KEY = {
    "prometheus": "metrics", "mimir": "metrics", "loki": "labels", "tempo": "tags",
    "jaeger": "services", "clickhouse": "tables", "dynatrace": "metrics", "datadog": "metrics",
}

_QUERY_LANG = {
    "prometheus": "PromQL", "mimir": "PromQL", "loki": "LogQL", "tempo": "TraceQL",
    "jaeger": "a Jaeger search query string", "clickhouse": "a read-only ClickHouse SQL SELECT",
    "dynatrace": "a Dynatrace metricSelector", "datadog": "a Datadog metric query",
}

_PROMPT_TEMPLATE = (
    "You are generating a single {lang} expression for a {kind} datasource, for an ops "
    "diagnostic dashboard. The datasource's schema has these {vocab_key}: {vocab}. Write ONE "
    "expression that surfaces a useful operational signal (error rate, latency, saturation, or "
    "volume) using ONLY names from the list above. Reply with ONLY the expression, no explanation, "
    "no markdown code fences."
)


def _vocab_names(schema, key):
    items = (schema or {}).get(key) or []
    names = []
    for x in items[:40]:
        if isinstance(x, str):
            names.append(x)
        elif isinstance(x, dict) and isinstance(x.get("name"), str):
            names.append(x["name"])
    return names


def _bedrock_invoke(prompt):
    """Default Bedrock invoke — identical model/pattern to graph_querygen._bedrock_invoke."""
    import boto3
    region = os.environ.get("AWS_REGION", "ap-northeast-2")
    model = os.environ.get("GRAPH_QUERYGEN_MODEL_ID", "global.anthropic.claude-haiku-4-5-20251001-v1:0")
    body = {"anthropic_version": "bedrock-2023-05-31", "max_tokens": 400,
            "messages": [{"role": "user", "content": prompt}]}
    resp = boto3.client("bedrock-runtime", region_name=region).invoke_model(modelId=model, body=json.dumps(body))
    payload = json.loads(resp["body"].read())
    return "".join(p.get("text", "") for p in payload.get("content", []))


def _generate_expr(kind, schema, invoke=None):
    """Ask the model for one query expression against `schema`'s vocabulary. `invoke` is injectable
    (tests never call Bedrock for real). May raise — the caller wraps this."""
    invoke = invoke or _bedrock_invoke
    vocab_key = _VOCAB_KEY.get(kind, "names")
    vocab = ", ".join(_vocab_names(schema, vocab_key)) or "(none)"
    prompt = _PROMPT_TEMPLATE.format(
        lang=_QUERY_LANG.get(kind, "query"), kind=kind, vocab_key=vocab_key, vocab=vocab)
    text = (invoke(prompt) or "").strip()
    if text.startswith("```"):
        text = text.strip("`").strip()
        first_line, _, rest = text.partition("\n")
        if rest and re.fullmatch(r"[a-zA-Z]+", first_line.strip()):
            text = rest
    return text.strip()


def _static_check(kind, expr):
    """(a) Structural guard. Pure; never raises."""
    if not isinstance(expr, str) or not expr.strip():
        return False
    if kind == "clickhouse":
        lowered = expr.lower()
        if ";" in expr.rstrip(";"):
            return False
        if not lowered.lstrip().startswith("select"):
            return False
        for kw in _FORBIDDEN_SQL_KEYWORDS:
            if re.search(rf"\b{kw}\b", lowered):
                return False
    return True


def _nonempty_result(kind, result):
    """True only when the connector's payload actually carries data.

    A successful-but-EMPTY response is not evidence the query works: an invented metric name returns
    Prometheus `result: []` with HTTP 200, and the signal would then be stored as a ready chip that is
    permanently empty until the schema drifts (review MAJOR, 2 models). The spec asks for a
    "non-error, non-empty-shape response", so the shape is checked per kind and anything unrecognised
    falls back to "must not be an empty container".
    """
    if isinstance(result, dict):
        data = result.get("data", result)
        if isinstance(data, dict):
            # prometheus/mimir: {"data": {"result": [...]}} — loki shares this shape
            if "result" in data:
                return bool(data.get("result"))
            # loki (streams response) / tempo (traces) / datadog-ish envelopes
            for key in ("streams", "traces", "series", "values", "rows", "data"):
                if key in data:
                    return bool(data.get(key))
            return bool(data)
        return bool(data)
    return bool(result)


# Outcomes, so the caller can tell "this schema has nothing to offer" (worth remembering) from "the
# attempt broke" (worth retrying). datasource_index only records a version sentinel for the former —
# otherwise a Bedrock throttle or a connector outage would be frozen into a permanent skip
# (review: the sentinel turned retryable failures into permanent ones).
DISABLED = "disabled"      # flag off — nothing changes until an operator acts
REJECTED = "rejected"      # the model answered and the answer failed a check: conclusive for this schema
TRANSIENT = "transient"    # something threw: retry next run
GENERATED = "generated"


def _dry_run_check(kind, expr, integration_id, invoke_connector):
    """(b) Live dry run against the connector. Returns (ok, transient): False on a generic
    error-envelope response or an empty payload (conclusive for this schema — see _nonempty_result),
    and (False, True) when the call itself threw, which is retryable."""
    arg_name = "sql" if kind == "clickhouse" else "query"
    args = {arg_name: expr, "instance_id": integration_id}
    if kind == "clickhouse":
        args["max_rows"] = 1
    try:
        result = invoke_connector(args)
    except Exception:
        return False, True      # connector down / timeout — not a verdict on the query
    if not result:
        return False, False
    if isinstance(result, dict) and "error" in result:
        return False, False
    return _nonempty_result(kind, result), False


def try_generate_signal(kind, schema, integration_id, invoke_connector, invoke_llm=None):
    """Back-compat wrapper: the row or None. Prefer try_generate_signal_with_status()."""
    return try_generate_signal_with_status(
        kind, schema, integration_id, invoke_connector, invoke_llm)[0]


def try_generate_signal_with_status(kind, schema, integration_id, invoke_connector, invoke_llm=None):
    """Entry point, called from datasource_index.py only when signal_catalog.build_signals matched
    zero ready rows for this kind. Returns (row_or_None, status) where status is one of DISABLED /
    GENERATED / REJECTED / TRANSIENT — never raises.

    The status exists so the caller can decide whether "no signal" is worth remembering. REJECTED
    means the model answered and its answer failed a check, which will repeat for the same schema;
    TRANSIENT means the attempt itself broke and the next run should try again.
    """
    if os.environ.get("GRAPH_QUERYGEN_ENABLED") != "true":
        return None, DISABLED
    try:
        expr = _generate_expr(kind, schema, invoke=invoke_llm)
        if not _static_check(kind, expr):
            return None, REJECTED
        ok, transient = _dry_run_check(kind, expr, integration_id, invoke_connector)
        if not ok:
            return None, (TRANSIENT if transient else REJECTED)
        tool = _KIND_TOOL.get(kind, f"{kind}_query")
        return {
            "signal_key": "generated_signal", "title": "AI 생성 신호", "status": "ready",
            "query": {"tool": tool, "queries": [{"label": "generated", "expr": expr}]},
            "missing_metrics": None,
            "meta": {"kind": kind, "provenance": "generated"},
        }, GENERATED
    except Exception as e:  # noqa: BLE001 — never break the catalog-based rebuild
        logging.warning("[signal_catalog_gen] generation failed for integration %s: %s", integration_id, e)
        return None, TRANSIENT
