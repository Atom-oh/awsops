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
            if f" {kw} " in f" {lowered} " or lowered.startswith(kw):
                return False
    return True


def _dry_run_check(kind, expr, integration_id, invoke_connector):
    """(b) Live dry run against the connector; False on ANY failure (conservative)."""
    tool = _KIND_TOOL.get(kind, f"{kind}_query")
    arg_name = "sql" if kind == "clickhouse" else "query"
    try:
        invoke_connector({arg_name: expr, "instance_id": integration_id})
        return True
    except Exception:
        return False


def try_generate_signal(kind, schema, integration_id, invoke_connector, invoke_llm=None):
    """Entry point, called from datasource_index.py only when signal_catalog.build_signals matched
    zero ready rows for this kind. Returns a ready row dict (same shape as build_signals' rows,
    plus meta.provenance='generated') on success, or None — never raises."""
    if os.environ.get("GRAPH_QUERYGEN_ENABLED") != "true":
        return None
    try:
        expr = _generate_expr(kind, schema, invoke=invoke_llm)
        if not _static_check(kind, expr):
            return None
        if not _dry_run_check(kind, expr, integration_id, invoke_connector):
            return None
        tool = _KIND_TOOL.get(kind, f"{kind}_query")
        return {
            "signal_key": "generated_signal", "title": "AI 생성 신호", "status": "ready",
            "query": {"tool": tool, "queries": [{"label": "generated", "expr": expr}]},
            "missing_metrics": None,
            "meta": {"kind": kind, "provenance": "generated"},
        }
    except Exception as e:  # noqa: BLE001 — never break the catalog-based rebuild
        logging.warning("[signal_catalog_gen] generation failed for integration %s: %s", integration_id, e)
        return None
